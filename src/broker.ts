import { createAltairSandboxPlugin, type AltairSandboxContext } from "./altair-adapter.js";
import { jsonSnapshot, snapshotPlugin, verifySource, type BrowserPlugin, type Json } from "./manifest.js";
import { untilAborted } from "./source.js";
import type { SandboxOptions } from "./session.js";

/** Compatible with StudioAuthoringPluginHostRequest; the source remains host-owned metadata. */
export interface BrowserPluginRequest {
  readonly id: string;
  readonly version: string;
  readonly configuration?: { readonly [key: string]: Json };
  readonly permissions: readonly string[];
  readonly source: unknown;
}

export interface BrowserPluginBrokerOptions {
  /** Resolve a trusted exact ID/version pin; loadPinnedBrowserPlugin supplies bounded HTTP loading. */
  readonly resolve: (request: BrowserPluginRequest, signal: AbortSignal) => Promise<BrowserPlugin>;
  /** Called once per activation, so grants/leases are never shared between registry instances. */
  readonly createOptions: (request: BrowserPluginRequest) => Omit<SandboxOptions, "permissions" | "signal"> & {
    readonly dispose?: () => void | Promise<void>;
  };
  readonly timeoutMs?: number;
}

const configurationKey = (value: unknown): string =>
  JSON.stringify(jsonSnapshot(value ?? {}), (_, entry) => {
    if (entry && typeof entry === "object" && !Array.isArray(entry))
      return Object.fromEntries(
        Object.entries(entry).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
      );
    return entry;
  });

/** Returns RPC proxy modules to the existing Studio loader; no second registry. */
export function createBrowserPluginBroker(options: BrowserPluginBrokerOptions) {
  const timeout = options.timeoutMs ?? 10000;
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 30000) throw new RangeError("Invalid broker deadline");
  return Object.freeze({
    async load(input: { readonly requested: readonly BrowserPluginRequest[]; readonly signal: AbortSignal }) {
      if (
        input.requested.length > 32 ||
        new Set(input.requested.map((entry) => entry.id)).size !== input.requested.length
      )
        throw new TypeError("Duplicate or excess plugin requests");
      const controller = new AbortController();
      const abort = () => controller.abort(input.signal.reason);
      input.signal.addEventListener("abort", abort, { once: true });
      if (input.signal.aborted) abort();
      const timer = setTimeout(() => controller.abort(new DOMException("Broker timed out", "TimeoutError")), timeout);
      try {
        const plugins = [];
        for (const entry of input.requested) {
          controller.signal.throwIfAborted();
          const request = Object.freeze({
            ...entry,
            source: jsonSnapshot(entry.source),
            permissions: Object.freeze([...entry.permissions]),
            ...(entry.configuration === undefined
              ? {}
              : { configuration: jsonSnapshot(entry.configuration) as { [key: string]: Json } }),
          });
          const descriptor = snapshotPlugin(
            await untilAborted(options.resolve(request, controller.signal), controller.signal),
          );
          if (
            descriptor.manifest.id !== request.id ||
            descriptor.manifest.version !== request.version ||
            new Set(request.permissions).size !== request.permissions.length ||
            request.permissions.some((permission) => !descriptor.permissions.includes(permission))
          )
            throw new TypeError("Resolved plugin identity or grants do not match the request");
          await verifySource(descriptor);
          controller.signal.throwIfAborted();
          plugins.push(
            Object.freeze({
              manifest: descriptor.manifest,
              async setup(context: AltairSandboxContext): Promise<void> {
                input.signal.throwIfAborted();
                if (
                  context.permissions.length !== request.permissions.length ||
                  context.permissions.some((permission) => !request.permissions.includes(permission)) ||
                  configurationKey(context.configuration) !== configurationKey(request.configuration)
                )
                  throw new Error("Activation grants or configuration changed after broker resolution");
                const owner = new AbortController();
                const cancel = () => owner.abort();
                context.signal.addEventListener("abort", cancel, { once: true });
                input.signal.addEventListener("abort", cancel, { once: true });
                if (context.signal.aborted || input.signal.aborted) cancel();
                const unlink = () => {
                  context.signal.removeEventListener("abort", cancel);
                  input.signal.removeEventListener("abort", cancel);
                };
                context.defer(unlink);
                const activation = options.createOptions(request);
                // Register selected editor/resource lease cleanup before activation can fail.
                let released: Promise<void> | undefined;
                const release = () => (released ??= Promise.resolve().then(() => activation.dispose?.()));
                const revoke = () => {
                  void release().catch(() => {});
                };
                owner.signal.addEventListener("abort", revoke, { once: true });
                context.defer(() => owner.signal.removeEventListener("abort", revoke));
                context.defer(release);
                if (owner.signal.aborted) revoke();
                await createAltairSandboxPlugin(descriptor, activation).setup({ ...context, signal: owner.signal });
              },
            }),
          );
        }
        return Object.freeze({ plugins: Object.freeze(plugins) });
      } finally {
        clearTimeout(timer);
        input.signal.removeEventListener("abort", abort);
      }
    },
  });
}
