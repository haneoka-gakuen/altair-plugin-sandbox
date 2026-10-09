// These two functions are serialized into isolated realms. Keep them self-contained.
function workerMain(): void {
  const scope = globalThis as unknown as {
    postMessage(value: unknown): void;
    onmessage: ((event: MessageEvent) => void) | null;
    editorPlugin: unknown;
  };
  const send = scope.postMessage.bind(scope);
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let sequence = 0;
  let handlers: Record<string, (value: unknown) => unknown> | undefined;
  const request = (operation: string, value: unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      send({ type: "request", id, operation, value });
    });
  Object.defineProperty(scope, "editorPlugin", {
    value: Object.freeze({
      define(methods: Record<string, (value: unknown) => unknown>) {
        if (handlers) throw new Error("Plugin already defined");
        handlers = methods;
        send({ type: "ready" });
      },
      resource: Object.freeze({ read: (id: string) => request("resource:read", id) }),
      hostMessage: (operation: string, value: unknown) => request(`host-message:${operation}`, value),
    }),
    writable: false,
    configurable: false,
  });
  scope.onmessage = async ({ data }) => {
    if (data.type === "ping") {
      send({ type: "pong", id: data.id });
      return;
    }
    if (data.type === "reply") {
      const item = pending.get(data.id);
      if (!item) return;
      pending.delete(data.id);
      if (data.ok) item.resolve(data.value);
      else item.reject(new Error(data.error));
      return;
    }
    if (data.type === "call") {
      try {
        const method = handlers && Object.hasOwn(handlers, data.method) && handlers[data.method];
        if (typeof method !== "function") throw new Error("Unknown method");
        send({ type: "result", id: data.id, ok: true, value: await method(data.value) });
      } catch {
        send({ type: "result", id: data.id, ok: false, error: "Plugin method failed" });
      }
    }
  };
}

function frameMain(): void {
  let accepted = false;
  window.addEventListener("message", (event) => {
    if (accepted || event.source !== parent || event.data !== "editor-plugin-connect" || event.ports.length !== 1)
      return;
    accepted = true;
    const port = event.ports[0]!;
    let worker: Worker | undefined;
    let url: string | undefined;
    const stop = (): void => {
      worker?.terminate();
      worker = undefined;
      if (url) URL.revokeObjectURL(url);
      url = undefined;
    };
    port.onmessage = ({ data }) => {
      if (data.type === "stop") {
        stop();
        port.postMessage({ type: "stopped" });
        port.close();
        return;
      }
      if (data.type === "start" && !worker) {
        try {
          url = URL.createObjectURL(new Blob([data.source], { type: "text/javascript" }));
          worker = new Worker(url, { name: "editor-plugin" });
          worker.onmessage = ({ data: message }) => port.postMessage(message);
          worker.onmessageerror = () => port.postMessage({ type: "crash" });
          worker.onerror = (error) => {
            error.preventDefault();
            port.postMessage({ type: "crash" });
          };
        } catch {
          stop();
          port.postMessage({ type: "crash" });
        }
        return;
      }
      worker?.postMessage(data);
    };
    port.start();
    window.addEventListener("pagehide", stop, { once: true });
  });
}

export interface SandboxTransport {
  send(message: unknown): void;
  stop(): Promise<void>;
}

export function createTransport(
  source: string,
  receive: (message: unknown) => void,
  crash: () => void,
): SandboxTransport {
  const frame = document.createElement("iframe");
  frame.hidden = true;
  frame.title = "Editor plugin worker isolation";
  frame.dataset.editorPluginSandbox = "";
  frame.setAttribute("sandbox", "allow-scripts");
  frame.referrerPolicy = "no-referrer";
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const policy = `default-src 'none'; script-src 'nonce-${nonce}'; worker-src blob:; connect-src 'none'; base-uri 'none'; form-action 'none'`;
  frame.srcdoc = `<meta http-equiv="Content-Security-Policy" content="${policy}"><script nonce="${nonce}">(${frameMain.toString()})();</script>`;
  const channel = new MessageChannel();
  let finishStop: (() => void) | undefined;
  let stopping: Promise<void> | undefined;
  let closed = false;
  channel.port1.onmessage = ({ data }) => {
    if (stopping) {
      if (data?.type === "stopped") finishStop?.();
      return;
    }
    receive(data);
  };
  channel.port1.onmessageerror = crash;
  frame.addEventListener(
    "load",
    () => {
      if (closed) return;
      frame.contentWindow!.postMessage("editor-plugin-connect", "*", [channel.port2]);
      channel.port1.postMessage({ type: "start", source: `(${workerMain.toString()})();\n${source}` });
    },
    { once: true },
  );
  channel.port1.start();
  document.body.append(frame);
  return {
    send(message) {
      if (!closed) channel.port1.postMessage(message);
    },
    stop() {
      if (stopping) return stopping;
      closed = true;
      stopping = new Promise<void>((resolve) => {
        const timer = setTimeout(() => finishStop?.(), 150);
        finishStop = () => {
          clearTimeout(timer);
          finishStop = undefined;
          channel.port1.onmessage = null;
          channel.port1.onmessageerror = null;
          channel.port1.close();
          channel.port2.close();
          frame.remove();
          resolve();
        };
        channel.port1.postMessage({ type: "stop" });
      });
      return stopping;
    },
  };
}
