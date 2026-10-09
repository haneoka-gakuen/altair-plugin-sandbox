export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** The existing Altair API 2 manifest, narrowed to a sandbox RPC service. */
export interface SandboxManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly apiVersion: 2;
  readonly capabilities: readonly ["services"];
  readonly dependencies?: Readonly<Record<string, string>>;
}

/** Execution metadata accompanies the existing catalog/lock identity. */
export interface BrowserPlugin {
  readonly manifest: SandboxManifest;
  readonly source: string;
  /** SHA-256 hex of the exact UTF-8 source, pinned by the trusted caller. */
  readonly sha256: string;
  readonly methods: readonly string[];
  readonly permissions: readonly string[];
}

export const LIMITS = Object.freeze({
  sourceBytes: 256 * 1024,
  jsonBytes: 64 * 1024,
  resourceBytes: 1024 * 1024,
  inflight: 8,
  messagesPerSecond: 64,
  requestsPerSession: 4096,
});

export function jsonSnapshot(value: unknown): Json {
  let nodes = 0;
  const visit = (item: unknown, depth: number): Json => {
    if (++nodes > 4096 || depth > 24) throw new TypeError("Message structure exceeds budget");
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "string") {
      if (item.length > LIMITS.jsonBytes) throw new TypeError("Message string exceeds budget");
      return item;
    }
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (Array.isArray(item)) {
      if (item.length > 4096 || Object.keys(item).length !== item.length)
        throw new TypeError("Message array exceeds budget or contains holes");
      return item.map((entry) => visit(entry, depth + 1));
    }
    if (!item || typeof item !== "object" || Object.getPrototypeOf(item) !== Object.prototype)
      throw new TypeError("Message must contain plain JSON");
    const result: { [key: string]: Json } = {};
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
      if (["__proto__", "constructor", "prototype"].includes(key) || !("value" in descriptor))
        throw new TypeError("Unsafe message property");
      result[key] = visit(descriptor.value, depth + 1);
    }
    return result;
  };
  const copy = visit(value, 0);
  if (new TextEncoder().encode(JSON.stringify(copy)).length > LIMITS.jsonBytes)
    throw new TypeError("Message exceeds byte budget");
  return copy;
}

export function snapshotPlugin(plugin: BrowserPlugin): BrowserPlugin {
  const manifest = plugin.manifest;
  if (
    !manifest ||
    manifest.apiVersion !== 2 ||
    !/^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/.test(manifest.id) ||
    manifest.id.length > 128 ||
    typeof manifest.name !== "string" ||
    !manifest.name.trim() ||
    manifest.name.length > 256 ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(manifest.version) ||
    manifest.capabilities?.length !== 1 ||
    manifest.capabilities[0] !== "services"
  )
    throw new TypeError("Expected an Altair API 2 services manifest with stable ID and version");
  if (
    typeof plugin.source !== "string" ||
    new TextEncoder().encode(plugin.source).length > LIMITS.sourceBytes ||
    !/^[0-9a-f]{64}$/.test(plugin.sha256)
  )
    throw new TypeError("Invalid pinned plugin source");
  const names = (values: readonly string[], pattern: RegExp): readonly string[] => {
    if (
      !Array.isArray(values) ||
      values.length > 32 ||
      new Set(values).size !== values.length ||
      values.some((value) => typeof value !== "string" || value.length > 96 || !pattern.test(value))
    )
      throw new TypeError("Invalid or duplicate method/permission declaration");
    return Object.freeze([...values]);
  };
  const dependencies = manifest.dependencies === undefined ? undefined : jsonSnapshot(manifest.dependencies);
  if (
    dependencies !== undefined &&
    (!dependencies ||
      Array.isArray(dependencies) ||
      typeof dependencies !== "object" ||
      Object.values(dependencies).some((range) => typeof range !== "string"))
  )
    throw new TypeError("Dependencies must be version ranges");
  return Object.freeze({
    manifest: Object.freeze({
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      apiVersion: 2,
      capabilities: Object.freeze(["services"] as const),
      ...(dependencies === undefined ? {} : { dependencies: Object.freeze(dependencies as Record<string, string>) }),
    }),
    source: plugin.source,
    sha256: plugin.sha256,
    methods: names(plugin.methods, /^[a-z][a-z0-9._-]*$/),
    permissions: names(plugin.permissions, /^(?:resource:read|host-message:[a-z][a-z0-9._-]*)$/),
  });
}

export async function verifySource(plugin: BrowserPlugin): Promise<void> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(plugin.source));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  if (hex !== plugin.sha256) throw new TypeError("Plugin source integrity mismatch");
}
