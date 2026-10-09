import { jsonSnapshot, LIMITS, type Json } from "./manifest.js";
import type { ResourceLease } from "./session.js";

export interface PluginEditorDocument {
  readonly path: string;
  readonly text: string;
  readonly revision: number;
  readonly external?: string;
}

/** Structural subset of the actual AltairEditorWorkspace public API. */
export interface PluginEditorWorkspace {
  document(path: string): PluginEditorDocument | undefined;
  getSnapshot(): { readonly files: readonly { readonly path: string; readonly blob: Blob }[] };
  update(path: string, text: string): void;
}

export interface EditorGrantOptions {
  readonly workspace: PluginEditorWorkspace;
  /** Owner must clear this fence as soon as the session/selection is replaced. */
  readonly isCurrent: () => boolean;
  readonly documents?: ReadonlyMap<string, string>;
  readonly resources?: ReadonlyMap<string, string>;
  /** Reuse the editor's document-format validation before update. */
  readonly validateText: (path: string, text: string) => void | Promise<void>;
}

const MAX_TEXT_BYTES = 32 * 1024;
const textBytes = (text: string): Uint8Array => {
  if (typeof text !== "string" || text.length > MAX_TEXT_BYTES) throw new RangeError("Editor text exceeds budget");
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > MAX_TEXT_BYTES) throw new RangeError("Editor text exceeds budget");
  return bytes;
};

/** A lease for selected documents and assets; never exposes the workspace object. */
export function createEditorGrantAdapter(options: EditorGrantOptions) {
  const documents = new Map(options.documents);
  const resources = new Map(options.resources);
  if (documents.size > 128 || resources.size > 1024) throw new RangeError("Too many editor grants");
  const reads = new Map<string, { token: string; revision: number; text: string }>();
  let disposed = false;
  const current = (signal: AbortSignal) => {
    signal.throwIfAborted();
    if (disposed || !options.isCurrent()) throw new Error("Editor grant is no longer current");
  };
  const fields = (value: Json, allowed: readonly string[]) => {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).some((key) => !allowed.includes(key))
    )
      throw new TypeError("Invalid editor request");
    return value;
  };
  const selected = (id: Json | undefined) => {
    if (typeof id !== "string" || !documents.has(id)) throw new Error("Document was not granted");
    const path = documents.get(id)!;
    const doc = options.workspace.document(path);
    if (
      !doc ||
      doc.path !== path ||
      doc.external !== undefined ||
      !Number.isSafeInteger(doc.revision) ||
      doc.revision < 0
    )
      throw new Error("Document is unavailable or has a conflict");
    return { id, path, doc };
  };
  return Object.freeze({
    resourceIds: Object.freeze([...resources.keys()]),
    async readResource(id: string, signal: AbortSignal): Promise<ResourceLease> {
      current(signal);
      const path = resources.get(id);
      if (path === undefined) throw new Error("Resource was not granted");
      const doc = options.workspace.document(path);
      if (doc) {
        if (doc.text.length > LIMITS.resourceBytes) throw new RangeError("Resource exceeds budget");
        const bytes = new TextEncoder().encode(doc.text);
        if (bytes.length > LIMITS.resourceBytes) throw new RangeError("Resource exceeds budget");
        current(signal);
        return { bytes };
      }
      const file = options.workspace.getSnapshot().files.find((file) => file.path === path);
      if (!file || file.blob.size > LIMITS.resourceBytes) throw new Error("Resource is unavailable or exceeds budget");
      const bytes = new Uint8Array(await file.blob.arrayBuffer());
      current(signal);
      // A replaced resource must not be delivered as the previous selection.
      if (options.workspace.getSnapshot().files.find((file) => file.path === path)?.blob !== file.blob)
        throw new Error("Resource changed during read");
      return { bytes };
    },
    hostMessages: Object.freeze({
      "editor-read": (value: Json, signal: AbortSignal): Json => {
        current(signal);
        const request = fields(value, ["id"]);
        const { id, doc } = selected(request.id);
        textBytes(doc.text);
        const token = crypto.randomUUID();
        const result = jsonSnapshot({ id, revision: doc.revision, text: doc.text, token });
        reads.set(id, { token, revision: doc.revision, text: doc.text });
        return result;
      },
      "editor-apply": async (value: Json, signal: AbortSignal): Promise<Json> => {
        current(signal);
        const request = fields(value, ["id", "token", "text"]);
        const { id, path } = selected(request.id);
        if (typeof request.token !== "string" || typeof request.text !== "string")
          throw new TypeError("Invalid text edit");
        textBytes(request.text);
        const baseline = reads.get(id);
        if (!baseline || baseline.token !== request.token) throw new Error("Edit must use the latest granted read");
        // A token authorizes a single attempt, including failed validation.
        reads.delete(id);
        await options.validateText(path, request.text);
        current(signal);
        const doc = selected(id).doc;
        if (doc.revision !== baseline.revision || doc.text !== baseline.text)
          throw new Error("Document changed while the plugin was working");
        // No async boundary between the final fence/CAS check and the existing update.
        options.workspace.update(path, request.text);
        return { applied: true };
      },
    }),
    dispose() {
      disposed = true;
      reads.clear();
    },
  });
}
