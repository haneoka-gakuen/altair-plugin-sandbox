import type { ResourceLease } from "./session.js";

/** Structural subset of Vega StoryResourceResolver; provider keeps its existing cache/abort behavior. */
export interface PluginResourceResolver {
  load(source: string, signal?: AbortSignal): Promise<Uint8Array>;
}

/** Explicit binding from approved opaque handles to provider-owned sources. */
export function createGrantedResourceReader(
  resolver: PluginResourceResolver,
  bindings: ReadonlyMap<string, string>,
): (id: string, signal: AbortSignal) => Promise<ResourceLease> {
  const selected = new Map(bindings);
  return async (id, signal) => {
    const source = selected.get(id);
    if (source === undefined) throw new Error("Resource was not selected");
    return { bytes: await resolver.load(source, signal) };
  };
}
