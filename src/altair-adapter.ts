import { snapshotPlugin, verifySource, type BrowserPlugin, type Json } from "./manifest.js";
import { BrowserPluginSession, startBrowserPlugin, type SandboxOptions } from "./session.js";

/** Structural subset of AltairPluginContextV2; no runtime dependency on Altair. */
export interface AltairSandboxContext {
  readonly signal: AbortSignal;
  readonly permissions: readonly string[];
  readonly configuration?: Readonly<Record<string, Json>>;
  provide<T>(key: { readonly id: string; readonly __type?: T }, value: T): () => void;
  defer(cleanup: () => void | Promise<void>): () => void;
}

export const sandboxServiceKey = (pluginId: string): { readonly id: string; readonly __type?: BrowserPluginSession } =>
  Object.freeze({ id: `${pluginId}.sandbox` });

/** The returned trusted proxy installs directly into the existing API 2 registry. */
export function createAltairSandboxPlugin(
  plugin: BrowserPlugin,
  options: Omit<SandboxOptions, "permissions" | "signal"> = {},
) {
  const pinned = snapshotPlugin(plugin);
  return Object.freeze({
    manifest: pinned.manifest,
    async setup(context: AltairSandboxContext): Promise<void> {
      const session = await startBrowserPlugin(pinned, {
        ...options,
        permissions: context.permissions,
        signal: context.signal,
      });
      // Register cleanup before the service: failed registry commits release the realm too.
      context.defer(() => session.stop());
      context.provide(sandboxServiceKey(pinned.manifest.id), session);
    },
  });
}

/** Verified same-ID replacement. Altair owns dependency and duplicate-ID checks. */
export async function replaceAltairSandboxPlugin(
  host: {
    list(): readonly { readonly id: string; readonly version: string }[];
    remove(id: string): Promise<void>;
    install(
      plugin: ReturnType<typeof createAltairSandboxPlugin>,
      options: { permissions: readonly string[] },
    ): Promise<void>;
  },
  plugin: BrowserPlugin,
  options: Omit<SandboxOptions, "signal">,
): Promise<void> {
  const pinned = snapshotPlugin(plugin);
  // Validate the new grant/deadline configuration before removing an active version.
  new BrowserPluginSession(pinned, options);
  await verifySource(pinned);
  const installed = host.list().find(({ id }) => id === pinned.manifest.id);
  if (!installed || installed.version === pinned.manifest.version)
    throw new Error("Replacement requires an installed ID and a different version");
  // A replacement uses freshly reviewed grants. Failure leaves the old ID disabled.
  await host.remove(pinned.manifest.id);
  await host.install(createAltairSandboxPlugin(pinned, options), { permissions: options.permissions });
}
