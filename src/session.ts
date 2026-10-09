import { createTransport, type SandboxTransport } from "./bootstrap.js";
import { jsonSnapshot, LIMITS, snapshotPlugin, verifySource, type BrowserPlugin, type Json } from "./manifest.js";

export interface ResourceLease {
  readonly bytes: Uint8Array;
  release?(): void;
}

export interface SandboxOptions {
  /** Exact grants from the existing Altair installation context. */
  readonly permissions: readonly string[];
  /** Opaque, explicitly selected references; copied on activation. */
  readonly resourceIds?: readonly string[];
  /** Reuses a caller-owned Altair/Vega resource provider. Must honor abort. */
  readonly readResource?: (id: string, signal: AbortSignal) => Promise<ResourceLease>;
  /** Trusted operations validate their own arguments and apply editor transactions. */
  readonly hostMessages?: Readonly<Record<string, (value: Json, signal: AbortSignal) => Json | Promise<Json>>>;
  readonly signal?: AbortSignal;
  /** Startup, each call, and provider operation deadline. Default 3000, range 100..30000 ms. */
  readonly timeoutMs?: number;
  /** Worker liveness deadline. Default 5000, range 100..30000 ms. */
  readonly heartbeatMs?: number;
}

interface Pending {
  resolve(value: Json): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  unlink(): void;
}

export type SandboxState = "starting" | "running" | "stopped" | "failed";

/** One activation lease. Identity/installation remain in AltairPluginHost. */
export class BrowserPluginSession {
  readonly plugin: BrowserPlugin;
  private readonly permissions: Set<string>;
  private readonly resources: Set<string>;
  private readonly operations: Readonly<Record<string, (value: Json, signal: AbortSignal) => Json | Promise<Json>>>;
  private readonly timeoutMs: number;
  private readonly heartbeatMs: number;
  private readonly controller = new AbortController();
  private readonly pending = new Map<number, Pending>();
  private readonly seenRequests = new Set<number>();
  private readonly providerTimers = new Set<ReturnType<typeof setTimeout>>();
  private transport?: SandboxTransport;
  private heartbeat?: ReturnType<typeof setInterval>;
  private startup?: ReturnType<typeof setTimeout>;
  private ping?: { id: number; at: number };
  private sequence = 0;
  private inflight = 0;
  private windowAt = 0;
  private messageCount = 0;
  private readyResolve?: () => void;
  private readyReject?: (error: Error) => void;
  private stopPromise?: Promise<void>;
  private unlinkOwner: () => void = () => {};
  private currentState: SandboxState = "starting";
  private failure?: Error;
  private started = false;

  constructor(
    plugin: BrowserPlugin,
    private readonly options: SandboxOptions,
  ) {
    this.plugin = snapshotPlugin(plugin);
    this.permissions = new Set(options.permissions);
    for (const permission of this.permissions)
      if (!this.plugin.permissions.includes(permission)) throw new TypeError("Grant exceeds declared permissions");
    this.resources = new Set(options.resourceIds ?? []);
    if (
      this.resources.size > 1024 ||
      [...this.resources].some((id) => typeof id !== "string" || !id || id.length > 4096)
    )
      throw new TypeError("Invalid resource grants");
    this.operations = Object.freeze({ ...options.hostMessages });
    const duration = (value: number | undefined, fallback: number): number => {
      const result = value ?? fallback;
      if (!Number.isInteger(result) || result < 100 || result > 30000) throw new RangeError("Invalid sandbox deadline");
      return result;
    };
    this.timeoutMs = duration(options.timeoutMs, 3000);
    this.heartbeatMs = duration(options.heartbeatMs, 5000);
  }

  get state(): SandboxState {
    return this.currentState;
  }
  get error(): Error | undefined {
    return this.failure;
  }

  async start(): Promise<void> {
    if (this.started || this.currentState !== "starting") throw new Error("Session already started or stopped");
    this.started = true;
    // Install the abort listener before hashing or creating a browser realm.
    if (this.options.signal) {
      const abort = () => {
        void this.stop();
      };
      this.options.signal.addEventListener("abort", abort, { once: true });
      this.unlinkOwner = () => this.options.signal?.removeEventListener("abort", abort);
      if (this.options.signal.aborted) {
        await this.stop();
        throw new Error("Plugin activation aborted");
      }
    }
    try {
      await verifySource(this.plugin);
      if (this.currentState !== "starting") throw new Error("Plugin activation aborted");
      await new Promise<void>((resolve, reject) => {
        this.readyResolve = resolve;
        this.readyReject = reject;
        this.startup = setTimeout(() => this.fail("Plugin startup timed out"), this.timeoutMs);
        this.transport = createTransport(
          this.plugin.source,
          (message) => this.receive(message),
          () => this.fail("Unreadable plugin message"),
        );
      });
      if (this.state !== "running") throw new Error("Plugin activation aborted");
      this.heartbeat = setInterval(
        () => {
          if (this.ping) {
            if (performance.now() - this.ping.at >= this.heartbeatMs) this.fail("Plugin heartbeat timed out");
          } else {
            this.ping = { id: ++this.sequence, at: performance.now() };
            this.transport?.send({ type: "ping", id: this.ping.id });
          }
        },
        Math.max(50, Math.floor(this.heartbeatMs / 2)),
      );
    } catch (error) {
      if (this.currentState === "starting") this.fail("Plugin activation failed");
      await this.stopPromise;
      throw error;
    }
  }

  call(method: string, value: Json = null, signal?: AbortSignal): Promise<Json> {
    if (this.currentState !== "running") return Promise.reject(this.failure ?? new Error("Plugin is not running"));
    if (!this.plugin.methods.includes(method)) return Promise.reject(new TypeError("Method was not declared"));
    if (signal?.aborted) return Promise.reject(new DOMException("Call aborted", "AbortError"));
    if (this.pending.size >= LIMITS.inflight) return Promise.reject(new Error("Plugin call budget exceeded"));
    const input = jsonSnapshot(value);
    const id = ++this.sequence;
    return new Promise<Json>((resolve, reject) => {
      const abort = () => {
        this.fail("Plugin call aborted");
      };
      signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => this.fail("Plugin call timed out"), this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, unlink: () => signal?.removeEventListener("abort", abort) });
      this.transport?.send({ type: "call", id, method, value: input });
    });
  }

  stop(): Promise<void> {
    return this.close("stopped", new Error("Plugin stopped"));
  }

  private fail(message: string): void {
    this.failure ??= new Error(message);
    void this.close("failed", this.failure);
  }

  private close(state: "stopped" | "failed", error: Error): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.currentState = state;
    this.controller.abort(error);
    this.unlinkOwner();
    clearTimeout(this.startup);
    clearInterval(this.heartbeat);
    for (const timer of this.providerTimers) clearTimeout(timer);
    this.providerTimers.clear();
    this.readyReject?.(error);
    this.readyResolve = undefined;
    this.readyReject = undefined;
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.unlink();
      item.reject(error);
    }
    this.pending.clear();
    this.seenRequests.clear();
    this.ping = undefined;
    this.stopPromise = this.transport?.stop() ?? Promise.resolve();
    return this.stopPromise;
  }

  private receive(input: unknown): void {
    if (this.currentState === "stopped" || this.currentState === "failed") return;
    try {
      const now = performance.now();
      if (now - this.windowAt >= 1000) {
        this.windowAt = now;
        this.messageCount = 0;
      }
      if (++this.messageCount > LIMITS.messagesPerSecond) throw new Error("Message rate exceeded");
      const data = jsonSnapshot(input);
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid envelope");
      const keys = (allowed: string[]) => {
        if (Object.keys(data).some((key) => !allowed.includes(key))) throw new Error("Unknown message field");
      };
      if (data.type === "ready") {
        keys(["type"]);
        if (this.currentState !== "starting") throw new Error("Repeated ready");
        this.currentState = "running";
        clearTimeout(this.startup);
        this.readyResolve?.();
        this.readyResolve = undefined;
        this.readyReject = undefined;
        return;
      }
      if (data.type === "crash") {
        keys(["type"]);
        throw new Error("Worker crashed");
      }
      if (this.currentState !== "running") throw new Error("Message before ready");
      if (typeof data.id !== "number" || !Number.isSafeInteger(data.id) || data.id < 1)
        throw new Error("Invalid request ID");
      if (data.type === "pong") {
        keys(["type", "id"]);
        if (data.id !== this.ping?.id) throw new Error("Unexpected pong");
        this.ping = undefined;
        return;
      }
      if (data.type === "result") {
        keys(["type", "id", "ok", "value", "error"]);
        const item = this.pending.get(data.id);
        if (
          !item ||
          typeof data.ok !== "boolean" ||
          (data.ok ? !Object.hasOwn(data, "value") : typeof data.error !== "string")
        )
          throw new Error("Invalid result");
        this.pending.delete(data.id);
        clearTimeout(item.timer);
        item.unlink();
        if (data.ok) item.resolve(data.value!);
        else item.reject(new Error("Plugin method failed"));
        return;
      }
      if (data.type === "request") {
        keys(["type", "id", "operation", "value"]);
        if (
          typeof data.operation !== "string" ||
          !Object.hasOwn(data, "value") ||
          this.seenRequests.has(data.id) ||
          this.seenRequests.size >= LIMITS.requestsPerSession ||
          this.inflight >= LIMITS.inflight
        )
          throw new Error("Invalid or excess provider request");
        this.seenRequests.add(data.id);
        void this.hostRequest(data.id, data.operation, data.value!);
        return;
      }
      throw new Error("Unknown message type");
    } catch {
      this.fail("Plugin protocol violation or worker crash");
    }
  }

  private async hostRequest(id: number, operation: string, value: Json): Promise<void> {
    this.inflight++;
    const timer = setTimeout(() => this.fail("Plugin provider request timed out"), this.timeoutMs);
    this.providerTimers.add(timer);
    try {
      if (!this.permissions.has(operation)) throw new Error("Permission denied");
      let result: Json | Uint8Array;
      if (operation === "resource:read") {
        if (typeof value !== "string" || !this.resources.has(value) || !this.options.readResource)
          throw new Error("Resource denied");
        const lease = await this.options.readResource(value, this.controller.signal);
        try {
          if (this.controller.signal.aborted) return;
          if (!(lease.bytes instanceof Uint8Array) || lease.bytes.byteLength > LIMITS.resourceBytes)
            throw new Error("Resource exceeds budget");
          result = lease.bytes.slice();
        } finally {
          lease.release?.();
        }
      } else {
        const name = operation.slice("host-message:".length);
        const handler = Object.hasOwn(this.operations, name) ? this.operations[name] : undefined;
        if (!operation.startsWith("host-message:") || !handler) throw new Error("Operation denied");
        result = jsonSnapshot(await handler(value, this.controller.signal));
      }
      if (!this.controller.signal.aborted) this.transport?.send({ type: "reply", id, ok: true, value: result });
    } catch {
      if (!this.controller.signal.aborted)
        this.transport?.send({ type: "reply", id, ok: false, error: "Host request denied or failed" });
    } finally {
      clearTimeout(timer);
      this.providerTimers.delete(timer);
      this.inflight--;
    }
  }
}

export async function startBrowserPlugin(
  plugin: BrowserPlugin,
  options: SandboxOptions,
): Promise<BrowserPluginSession> {
  const session = new BrowserPluginSession(plugin, options);
  await session.start();
  return session;
}
