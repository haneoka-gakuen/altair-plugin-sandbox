import { LIMITS, snapshotPlugin, verifySource, type BrowserPlugin } from "./manifest.js";

/** Host-approved metadata pinned to the existing catalog identity. */
export interface PinnedBrowserPlugin extends Omit<BrowserPlugin, "source"> {
  readonly url: string;
}

export interface PluginSourceOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}

/** Also bounds a caller-supplied loader that returns after cancellation. */
export function untilAborted<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Downloads text only. Plugin code is executed later by the isolated activation. */
export async function loadPinnedBrowserPlugin(
  pin: PinnedBrowserPlugin,
  options: PluginSourceOptions = {},
): Promise<BrowserPlugin> {
  const metadata = snapshotPlugin({ ...pin, source: "" });
  const url = new URL(pin.url);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && local)) || url.username || url.password || url.hash)
    throw new TypeError("Expected a pinned HTTPS source or loopback development URL");
  const timeout = options.timeoutMs ?? 10000;
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 30000) throw new RangeError("Invalid download deadline");
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = setTimeout(
    () => controller.abort(new DOMException("Plugin download timed out", "TimeoutError")),
    timeout,
  );
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let complete = false;
  try {
    controller.signal.throwIfAborted();
    const pending = (options.fetch ?? globalThis.fetch)(url.href, {
      method: "GET",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    });
    // A late custom fetch still releases its body; it cannot create a realm.
    void pending.then(
      (response) => {
        if (controller.signal.aborted) void response.body?.cancel().catch(() => {});
      },
      () => {},
    );
    const response = await untilAborted(pending, controller.signal);
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new Error(`Plugin source HTTP ${response.status}`);
    }
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > LIMITS.sourceBytes)) {
      void response.body?.cancel().catch(() => {});
      throw new RangeError("Plugin source exceeds byte budget");
    }
    if (!response.body) throw new TypeError("Plugin source has no body");
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const part = await untilAborted(reader.read(), controller.signal);
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > LIMITS.sourceBytes) throw new RangeError("Plugin source exceeds byte budget");
      chunks.push(part.value);
    }
    complete = true;
    const buffer = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
    const plugin = snapshotPlugin({ ...metadata, source });
    await verifySource(plugin);
    controller.signal.throwIfAborted();
    return plugin;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    if (!complete) {
      controller.abort();
      void reader?.cancel().catch(() => {});
    }
    reader?.releaseLock();
  }
}
