# @once/webext-runtime

Once's own runtime for the Firefox flavour of WebExtensions, without a host.
Electron's main process and the Once Lite Android broker both load uBlock
Origin, Violentmonkey and user-installed XPIs through it; each supplies the
engine-specific parts (pages, worlds, request interception, files, cookies)
and this package decides what an extension sees and may do.

Pages needing only the AMO install bridge can import `@once/webext-runtime/amo`;
this avoids bundling the full preload API builder and protocol into every page.

## What is here

| Module | Role |
| --- | --- |
| `protocol.ts` | The contract between the privileged side and the page-side `browser` builder: IPC channel names, context init payloads, the API allowlists (`EXTENSION_API_SURFACE`, `CONTENT_API_SURFACE`), DNR limits, privacy defaults |
| `preloadRuntime.ts`, `amoShim.ts` (also exported as `@once/webext-runtime/preload`) | `PreloadApi` builds `browser.*` over an `ApiTransport`; `adoptBridge`/`ADOPT_BRIDGE_SOURCE` turn a staged copy into page globals; the `navigator.mozAddonManager` shim for addons.mozilla.org. Free of Node, so it bundles into preloads and WebView bootstraps |
| `ExtensionContexts.ts`, `ExtensionPorts.ts`, `VirtualContext.ts` | Where an extension runs (background, popup, options, pages, content worlds), listener registry, request/reply with timeouts, ports, and a privileged in-process context Once messages extensions from |
| `ExtensionApi.ts`, `apiExtras.ts`, `scriptingApi.ts`, `dnrApi.ts`, `apiTargets.ts`, `apiDispatch.ts` | The `browser.*` handler table (`createApiHandlers()`), allowlist and permission checks for calls and listener changes (`invokeApi`, `applyListenerChange`) |
| `webRequestDetails.ts`, `WebRequestRouter.ts`, `dnrBridge.ts`, `DnrRulesets.ts` | Request details synthesis, listener filters, blocking-response merge; the per-stage router with Firefox ordering; declarativeNetRequest enforcement and rulesets |
| `LoadedExtension.ts`, `ExtensionProtocol.ts`, `contentScripts.ts`, `ExtensionScheme.ts` | Loading an unpacked package, serving `moz-extension://` requests as WHATWG `Response`s, content-script matching and batching, host derivation and URLs |
| `ExtensionStorage.ts` | `storage.local`/`storage.sync` with debounced writes over a `JsonStore` |
| `ExtensionManager.ts`, `ExtensionPackage.ts`, `bundledExtensions.ts` | The installed catalogue, AMO listing and hash checks, archive validation, enable/disable/remove, selected-key sync; the bundled list |
| `ExtensionSettingsCoordinator.ts`, `extensionSettingsApply.ts` | Handing Once's filter lists and userscripts to uBlock and Violentmonkey through their own message APIs |
| `node/` (`@once/webext-runtime/node`) | Node implementations of the file and store interfaces: `NodeJsonStore`, `nodeFileReader`/`loadUnpackedExtension`/`resolveExtensionFile`, `NodePackageStore`, `sha256Node` |

Nothing outside `src/node/` imports `electron`, `node:*`, `Buffer` or
`process`; `eslint.config.mjs` enforces that, and `scripts/check-boundaries.js`
keeps the package on `@once/core` alone.

## Host contract

A host implements the interfaces in `hostServices.ts` and `runtimeTypes.ts`:

- **Tabs** — `ExtensionShellHooks`: `tabs()`, `createTab`, `updateTab`,
  `moveTab`, `removeTab`, `reloadTab`, `onTabsChanged`. Tab ids are the
  host's numbers (Electron: webContents ids). The host adds its own
  tab-creation hook on top and turns tab lifecycle into `tabs.*` and
  `webNavigation.*` events itself.
- **Transports** — a `ContextEntry` per place an extension runs, registered
  with `ExtensionContexts.addEntry`: `send(message)` delivers an
  `ExtensionEvent`, `url()` and `isDestroyed()` describe the document, and
  the host feeds `ExtensionInvoke`, `ListenerChange` and `ExtensionReply`
  messages from the other side into `invokeApi`, `applyListenerChange` and
  `contexts.handleReply` after authenticating the sender. On the page side
  `PreloadApi` takes an `ApiTransport` (`invoke`, `reply`, synchronous
  `listen`).
- **Files** — `ExtensionFileReader.read(relativePath)`: synchronous, because
  content scripts are read when a frame asks, before its document exists.
  Paths arrive normalised (`extensionFilePath`), with no leading slash and no
  `..`.
- **Stores** — `JsonStore.read(name)`/`write(name, value)`: one JSON document
  per name, written atomically; `read` answers `undefined` for a document
  that never existed and throws for one that cannot be parsed. One store per
  extension holds `storage.json`, `sync.json`, `dnr.json` and the settings
  hand-off records; the manager's store holds `installed.json`.
- **Cookies** — `CookieStore` with `get`/`set`/`remove`/`onChanged` in
  WebExtension cookie shapes (`WebExtCookie`, `CookieQuery`,
  `CookieSetDetails`); `broadcastCookieChange` fans a change out to the
  hosts allowed to see it.
- **Platform** — `RuntimePlatform`: `locale()`, `os`, `arch`, for
  `i18n` and `runtime.getPlatformInfo`.
- **Packages** — `ExtensionPackageHost`: `fetch` for Mozilla's servers,
  `sha256`, `unzip`, `readArchive` for a user-picked file, `locale()`, and an
  `ExtensionPackageStore` (`directory(token)`, `mkdir`, `writeFile` that
  refuses to overwrite, `remove`, `list`, `canonical`, `reader`).
- **Requests** — the host maps its own request records to
  `WebRequestDetailsInput` and calls `WebRequestRouter.beforeRequest`,
  `beforeSendHeaders`, `headersReceived` (blocking) and `sendHeaders`,
  `responseStarted`, `beforeRedirect`, `completed`, `errorOccurred`
  (notifications), mapping `RequestDecision`s back. `DeclarativeRequestHooks`
  is what `DnrEnforcer` provides.
- **Serving** — `serveExtensionRequest(url, lookup, options)` answers a
  `moz-extension://` request with a `Response`; `OwnPageRequests` carries the
  grant from the router's `requestFrom` hook to the handler.

Everything a host implements must also hold the `ApiHost` shape the handlers
see (`ExtensionApi.ts`): the loaded extension, its contexts, ports, storages,
store, files, hooks, action state, alarms, cookies, platform, registered
scripts and DNR rulesets. Electron's `ExtensionHost`
(`apps/electron/src/extensions/ExtensionHost.ts`) is the reference.

## Tests

`tests/unit/webext-runtime/` exercises the package against its `dist` output
with fake contexts and the Node adapters; `tests/unit/electron/` keeps the
tests of Electron's adapters. Run `npm run test:unit`.
