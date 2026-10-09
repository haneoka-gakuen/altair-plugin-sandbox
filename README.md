# Altair plugin sandbox

This package supplies one isolated activation and a trusted proxy for the existing Altair API 2 registry. The application keeps its catalog, project plugin list, lock, dependency checks and permission review. Browser plugin source runs in a dedicated Worker created inside an opaque sandboxed iframe. A local plugin explicitly trusted by the application continues to use `AltairPluginHost.install()` directly.

From this independent repository, run `npm install` and `npm run check`. `npm pack --dry-run` checks the distribution entries. The main import has no DOM side effects; starting a browser session requires a document with a body, Web Crypto, MessageChannel, blob Workers and sandboxed `srcdoc` frames.

## Plugin source and manifest

Plugin source is a classic, self-contained JavaScript script. It registers handlers once:

```js
editorPlugin.define({
  async inspect() {
    const bytes = await editorPlugin.resource.read("selected-script");
    const text = new TextDecoder().decode(bytes);
    return editorPlugin.hostMessage("report", { lines: text.split("\n").length });
  },
});
```

The application obtains source through its approved package/catalog loader and verifies the exact source against a hash recorded with the selected version. A plugin-provided hash alone does not establish publisher trust. `BrowserPlugin` carries the existing manifest alongside a small execution descriptor:

| Field                   | Type                 | Requirement                                                                                                                                           |
| ----------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifest.id`           | string               | Stable Altair plugin ID, at most 128 characters; lowercase letters, digits, `.`, `_`, `-` and slash-separated segments.                               |
| `manifest.name`         | string               | Nonempty display name, at most 256 characters.                                                                                                        |
| `manifest.version`      | string               | Exact semantic version; the existing Altair host performs its full semver check.                                                                      |
| `manifest.apiVersion`   | `2`                  | Required.                                                                                                                                             |
| `manifest.capabilities` | `["services"]`       | Required; this proxy exposes a constrained RPC service.                                                                                               |
| `manifest.dependencies` | string-to-string map | Optional existing Altair dependency IDs/ranges; the registry checks them.                                                                             |
| `source`                | string               | Required exact UTF-8 script; maximum 256 KiB.                                                                                                         |
| `sha256`                | string               | Required 64-character lowercase hex SHA-256 of that script.                                                                                           |
| `methods`               | string[]             | Required unique RPC method names, maximum 32. Names start with a lowercase letter and use letters, digits, `.`, `_`, `-`; maximum 96 characters each. |
| `permissions`           | string[]             | Required unique declarations, maximum 32: `resource:read` and/or `host-message:<operation>`. Operation names follow the method-name syntax.           |

All declared permissions still require an exact grant in the Altair installation options. Browser plugins cannot choose local trusted execution by adding a manifest field.

## Install, call, disable and replace

```ts
import { AltairPluginHost } from "@haneoka/altair/plugins";
import {
  createAltairSandboxPlugin,
  createGrantedResourceReader,
  sandboxServiceKey,
  replaceAltairSandboxPlugin,
} from "@haneoka/altair-plugin-sandbox";

const host = new AltairPluginHost();
// `resolver` is the application's existing StoryResourceResolver.
const selected = new Map([["selected-script", "project-resource:script"]]);
const options = {
  resourceIds: [...selected.keys()],
  readResource: createGrantedResourceReader(resolver, selected),
  hostMessages: {
    report(value, signal) {
      if (signal.aborted) throw new Error("Stopped");
      // Validate the report schema and apply a host-owned editor transaction.
      return value;
    },
  },
};
const grants = ["resource:read", "host-message:report"];
await host.install(createAltairSandboxPlugin(plugin, options), { permissions: grants });
const session = host.service(sandboxServiceKey(plugin.manifest.id));
const result = await session!.call("inspect");
await host.remove(plugin.manifest.id); // stop Worker, revoke blob, remove iframe/service

// Reinstall or replace an active version using its newly reviewed descriptor/grants:
await host.install(createAltairSandboxPlugin(plugin, options), { permissions: grants });
await replaceAltairSandboxPlugin(host, upgradedPlugin, { ...options, permissions: grants });
await host.dispose();
```

Replacement requires the same installed ID and a different version. It validates the new execution descriptor, grants and source hash before removal. The existing host rejects removal when dependents require that ID. Once removal succeeds, an activation failure leaves the ID disabled; the application can reinstall the previous pinned version explicitly. Independent registry operations should be serialized by the application during replacement.

`sandboxServiceKey(id)` returns the existing Altair service key `<id>.sandbox`. `createAltairSandboxPlugin()` returns an API 2 plugin object that the application owns and trusts. Its setup supplies only a `BrowserPluginSession` service to the registry and registers cleanup through `context.defer()`.

## Activation options

`startBrowserPlugin(plugin, options)` starts one session directly. `createAltairSandboxPlugin(plugin, options)` accepts the same options except `permissions` and `signal`, which it obtains from the Altair installation context.

| Option         | Type                                     | Default and behavior                                                                                                                                                                                             |
| -------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `permissions`  | readonly string[]                        | Required for direct activation; exact granted subset of descriptor declarations.                                                                                                                                 |
| `resourceIds`  | readonly string[]                        | Empty. Selected opaque IDs only, maximum 1024, each nonempty and at most 4096 characters.                                                                                                                        |
| `readResource` | `(id, signal) => Promise<ResourceLease>` | Absent. Reuses the caller's provider and must honor abort. A lease has `bytes: Uint8Array` and optional synchronous `release()`. Bytes are copied before sending; release also runs for late results after stop. |
| `hostMessages` | operation-to-handler map                 | Empty. Each handler receives bounded JSON and an AbortSignal, validates its schema, and returns bounded JSON. Names require the corresponding `host-message:<name>` grant.                                       |
| `signal`       | AbortSignal                              | Optional activation owner. Abort stops the activation and rejects pending calls.                                                                                                                                 |
| `timeoutMs`    | integer                                  | 3000 ms, range 100–30000. Applies to startup, each call and each provider operation.                                                                                                                             |
| `heartbeatMs`  | integer                                  | 5000 ms, range 100–30000. Bounds silent closure or a busy Worker outside an active call. Background-tab timer scheduling may delay detection.                                                                    |

`createGrantedResourceReader(resolver, bindings)` snapshots an explicit map of opaque ID to provider source and calls `resolver.load(source, signal)`. It preserves the provider's URL/path handling, cache and cancellation policy. Select only the resources the user granted. Broad URL prefix grants, host credentials, resource browser `reference` objects and entire project state should remain with the application.

## Session and plugin APIs

`session.call(method, value = null, signal?)` accepts only declared methods and bounded JSON; it resolves with bounded JSON. Cancelling one call stops the activation, so abandoned work cannot continue applying host operations. Up to eight calls can be pending. `session.stop()` is idempotent and resolves after transport disposal. `state` is `starting`, `running`, `stopped` or `failed`; `error` reports the host's failure reason. A failed service remains inspectable in the registry until its owner removes it; calls reject immediately.

Inside the Worker, `editorPlugin.resource.read(id)` resolves to a copied `Uint8Array`, maximum 1 MiB per resource. `editorPlugin.hostMessage(operation, value)` resolves to bounded JSON. Host callback errors are reduced to a generic message, keeping application exception details inside the host. `editorPlugin.define(handlers)` announces readiness and installs named async or synchronous methods. Return JSON from handlers.

Incoming JSON is capped at 64 KiB, 4096 nodes and depth 24. Provider requests allow eight outstanding operations, 4096 unique request IDs per activation, and 64 messages per second. Malformed, duplicate, oversized or excess messages fail the activation. Worker exceptions, missing readiness, missed heartbeat and timed-out calls/provider operations stop it too. No automatic retry restarts plugin side effects.

## Browser policy and cleanup

The iframe uses `sandbox="allow-scripts"` without same-origin authority. It runs only the trusted relay; third-party code runs in its Worker. The frame policy uses `default-src 'none'`, a nonce for the relay, `worker-src blob:`, `connect-src 'none'`, `base-uri 'none'` and `form-action 'none'`. The browser enforces network denial and opaque-origin storage restrictions. The host transfers a fresh MessagePort to the particular frame and accepts plugin messages only on that port.

Blob Workers inherit the creator's CSP; see [CSP Level 3](https://www.w3.org/TR/CSP/) and the [HTML Worker specification](https://html.spec.whatwg.org/multipage/workers.html). The application's own CSP also applies to `srcdoc`. A policy blocking the nonce relay or blob Workers makes startup fail closed; this package never changes application or cloud policy.

Stopping aborts provider work, rejects pending calls, clears timers/listeners, terminates the Worker, revokes its source blob and removes the frame. A relay acknowledgment is bounded to 150 ms; removal is the fallback if the relay cannot respond. Trusted providers must release owned I/O on abort and check the signal before committing editor changes. This mechanism bounds protocol work and execution time; browser-process memory exhaustion is not a per-plugin quota. Native Electron/Tauri hosts must keep privileged APIs out of this browser realm.

This package introduces no visible editor panel. The application's existing MD3 controls, centralized translations and mobile layout should render permissions, status, disable and upgrade actions.

## Online source and Studio broker

`loadPinnedBrowserPlugin(pin, options)` fetches a host-approved source without executing it. `pin` has the `BrowserPlugin` metadata fields described above, replaces `source` with an absolute `url`, and retains the exact `sha256`. HTTPS is supported; HTTP is accepted for `localhost`, `127.0.0.1` and `[::1]` development only. URL credentials, fragments and redirects are rejected. Requests use GET, `credentials: "omit"` and `referrerPolicy: "no-referrer"`. The loader reads a maximum of 256 KiB, preserves exact UTF-8 text including a BOM, verifies its hash and cancels unfinished bodies.

Its options are `signal?: AbortSignal`, `fetch?: typeof fetch` (the existing host fetcher), and `timeoutMs?: number` (10000, integer range 100–30000 ms, covering headers, body and verification). HTTP errors, malformed UTF-8, excess bytes, hash mismatch, timeout and cancellation reject without creating a realm.

`createBrowserPluginBroker({ resolve, createOptions, timeoutMs? })` implements the existing Studio authoring broker's `load({ requested, signal })` interface. It returns API 2 proxy plugins to `loadStudioAuthoringPlugins()`; that loader still owns installation, dependency ordering and registry disposal. At most 32 unique plugin IDs are accepted in a load. The default total resolution deadline is 10000 ms, range 100–30000. Resolution cancellation settles even if a custom resolver ignores abort.

Each requested entry carries `id`, `version`, `permissions`, `source` and optional `configuration`. `resolve(request, signal)` is a trusted callback returning the approved `BrowserPlugin` for that exact ID/version. The source object stays inside the host. Configuration is made available to the host's options factory; it is not automatically exposed to the Worker. `createOptions(request)` supplies resource/host-message options and optional `dispose(): void | Promise<void>` **once per activation**. Installation grants must match the broker request. The broker request's signal and the registry context's signal both stop the Worker and release the selected-resource lease. Registry disposal also awaits lease cleanup once.

```ts
const broker = createBrowserPluginBroker({
  resolve(request, signal) {
    // approvedPins belongs to the application's existing catalog/lock selection.
    const pin = approvedPins.get(`${request.id}@${request.version}`);
    if (!pin) throw new Error("Plugin version is unavailable");
    return loadPinnedBrowserPlugin(pin, { signal });
  },
  createOptions() {
    return createEditorGrantAdapter({
      workspace: session.editorWorkspace,
      isCurrent: () => currentSession === session,
      documents: new Map([["selected", "scenes/opening.scene.yaml"]]),
      resources: new Map([["selected-image", "assets/星空.png"]]),
      validateText: (path, text) => session.validateDocument(path, text),
    });
  },
});
// Supply `broker` at the application's existing authoring-broker configuration point.
// Browser third-party entries use this proxy; trusted local/builtin entries keep their host.
```

## Selected editor transactions

`createEditorGrantAdapter(options)` returns `resourceIds`, `readResource`, `hostMessages` and `dispose`, ready to use as broker activation options. It adapts the actual Altair workspace `document(path)`, `getSnapshot().files` and synchronous `update(path, text)` methods.

| Option                     | Requirement                                                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspace`                | Required host workspace; stays inside the host.                                                                                                         |
| `isCurrent()`              | Required synchronous session/selection fence. The caller invalidates it immediately on a switch, before awaiting teardown.                              |
| `documents`                | Optional opaque ID-to-document-path map, maximum 128 entries; empty by default.                                                                         |
| `resources`                | Optional opaque ID-to-resource-path map, maximum 1024 entries; empty by default.                                                                        |
| `validateText(path, text)` | Required host-format validator, synchronous or async. Reuse the editor's validator for YAML scenes or the chart editor's validator for chart documents. |

Two host-message operations are available. Each still requires its corresponding exact grant:

- `editor-read({ id })`, permission `host-message:editor-read`, returns `{ id, revision, text, token }` for a granted, conflict-free document.
- `editor-apply({ id, token, text })`, permission `host-message:editor-apply`, validates replacement text and checks that the same document revision/text, current scope and live signal still hold. It then calls the existing synchronous update once and returns `{ applied: true }`. The one-use token comes from the latest read of that ID; a failed validation also consumes it. Save/history/undo remain the editor's responsibility.

Document text is bounded to 32 KiB UTF-8 per read/replacement so it fits the 64 KiB message budget. Larger documents can be read through selected resources; applying larger documents requires a host-defined typed edit operation. Resource reads prefer current unsaved text for open documents and otherwise read the selected Blob, maximum 1 MiB. A changed Blob or switched session during an async read is rejected. Neither raw paths, other files, folder handles nor the workspace itself are accepted from the plugin.

Inside an isolated script:

```js
editorPlugin.define({
  async transform() {
    const read = await editorPlugin.hostMessage("editor-read", { id: "selected" });
    return editorPlugin.hostMessage("editor-apply", {
      id: "selected",
      token: read.token,
      text: read.text.replace("Old text", "New text"),
    });
  },
});
```

This package is prepared for local workspace and tarball consumers. Public npm publication is a separate release step.
