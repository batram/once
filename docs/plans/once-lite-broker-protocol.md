# Once Lite: the broker protocol

Status: M2 draft (2026-10-19). The TypeScript side of this contract is
`apps/mobile/src/lite/protocol.ts`; this document is the prose version and
the Java agent's specification. Anything marked **TBD** is not settled yet
and may change; everything else is what the broker implements.

The broker is the "main process" of the WebExtension runtime: the bundle
`lite-runtime.js` (page `lite-runtime.html`, both built by
`apps/mobile/webpack.config.js` when `ONCE_MOBILE_PLATFORM=android`) running
in a hidden WebView. Java is deliberately dumb I/O: it owns WebViews, the
DevTools connection, files, the network and dialogs, and forwards what the
broker asks for. The broker never touches any of those itself, which is why
it is unit-tested in Node with a fake Java.

## Transports

| Channel | Direction | Mechanism |
| --- | --- | --- |
| `window.onceLite` | Java ↔ broker | `WebViewCompat.addWebMessageListener(brokerView, "onceLite", ["https://localhost"])`. The broker calls `onceLite.postMessage(string)` and assigns `onceLite.onmessage`. Java posts through the `JavaScriptReplyProxy` it got on the first message from the page (the broker sends a `broker.hello` event at load so Java has the proxy before `lite.start`). |
| `window.onceLiteFiles` | broker → Java, synchronous | `addJavascriptInterface(obj, "onceLiteFiles")` on the broker WebView only. `String read(String directory, String path)` and `String unzip(String token, String archiveBase64)`, see Files. |
| `window.onceLitePage` | Java ↔ extension page frames | `WebViewCompat.addWebMessageListener(pageView, "onceLitePage", [origin])` on every extension page WebView and (restricted to extension origins) on tab WebViews. One `JavaScriptReplyProxy` per frame; Java numbers frames per page (`0` = main frame) and relays each frame's messages as `page.message`. |
| `onceLiteWorld` binding | content world → Java → broker | `Runtime.addBinding {name: "onceLiteWorld", executionContextName: "once-ext:<host>"}` per extension per tab target. `Runtime.bindingCalled` is forwarded as a `cdp.event`. |
| `__onceLiteDeliver(json)` | broker → world | The broker sends `cdp.command Runtime.evaluate {expression, contextId}`; Java issues it. |
| `onceLiteBridge` binding, `__onceLiteBridgeDeliver(json)` | Once's own bridge world ↔ Java | Not routed through the broker; Java handles it with its Gecko-era handlers (see Bridge world). |

Every message on `onceLite` is one JSON envelope:

```jsonc
{ "type": "request", "id": 7, "method": "cdp.command", "params": { ... } }
{ "type": "response", "id": 7, "result": { ... } }
{ "type": "response", "id": 7, "error": "message", "code": "NOT_RUNNING" }   // code optional
{ "type": "event", "event": "cdp.event", "params": { ... } }
```

Request ids are per sender (Java and the broker each count their own). A
request with an unknown method is answered with an error. Events are never
answered. Order within the channel is preserved; nothing else is.

## Lifecycle

### Java → broker

| Method | Params | Result | Notes |
| --- | --- | --- | --- |
| `lite.start` (request) | `{bundled: [{id, directory, present}], locale, arch, token, storageRoot}` | `{ready: true, extensions: CatalogEntry[]}` | Once per broker page, after the broker's `broker.hello` event. `bundled` lists the shipped extensions (ids from `scripts/fetch-extensions.js`: `uBlock0@raymondhill.net` in `ublock-origin`, `{aecec67f-0d10-4fa7-b7c7-609a2db280cf}` in the plain `violentmonkey` bundle, **not** the Gecko-adapted `android/violentmonkey`); `directory` is whatever string `onceLiteFiles.read` resolves (an `asset:` prefix for APK assets is Java's own convention). `token` is a random secret (32+ hex chars) generated per app process and also given to the bridge/main helper scripts. `storageRoot` is the directory JSON stores live under (`<files>/lite-extensions`). The broker restores the catalogue, loads enabled extensions (opening their background pages) and installs the world registrations before answering. |
| `extension.command` (request) | `{action, id?, source?, enabled?, file?}` | `{extensions?, cancelled?, noPage?}` | The shell's `extensionCommand` verbatim (`MobileExtensionCommand`). `list` answers the catalogue in the exact `MobileBrowserExtension` shape (`id, name, iconDataUrl?, description, version, enabled, bundled, hasOptions, hasAction, permissions, disabledReason`). `install {source}` previews an AMO listing/XPI URL, asks `ui.confirm`, installs. `chooseFile` asks `ui.pickFile` unless `file` is given, then the same. `enable {id, enabled}`, `remove {id}` (confirmed), `update {id}`, `options {id}` and `action {id}` (answer `noPage: true` when the extension has no such page; `action` without a popup fires `browserAction.onClicked`). Errors are answered as request errors; `code: "INVALID_SOURCE"` for a source that is neither AMO nor a file. |
| `extensions.list` (request) | – | `CatalogEntry[]` | The catalogue alone. |
| `settings.apply` (request) | `{filterLists, userscripts}` | – | The shell's `applyExtensionSettings` documents. Filter lists are handed to uBlock Origin through its dashboard port; userscripts are **not** applied here (the `GeckoViolentmonkey` hand-off below does that), see `liteSettings.ts`. |
| `violentmonkey.send` (request) | `{cmd, data?}` | `{value}` | `LiteViolentmonkeyPlugin.send`. Error `code: "NOT_RUNNING"` while Violentmonkey is not loaded. `OnceReadRecords`/`OnceWriteRecords` are answered from the Violentmonkey host's JSON store (`once-relay-records.json`); every other command is sent to Violentmonkey's background as a runtime message from a privileged `VirtualContext`. |
| `violentmonkey.handingOff` (request) | – | – | Holds every tab main-frame document request at the `Fetch` request stage until `settled` (60 s safety release). |
| `violentmonkey.settled` (request) | – | – | Releases them. |

### Broker → Java

| Event | Params | Notes |
| --- | --- | --- |
| `broker.hello` | – | First message from the broker page; Java keeps the reply proxy, then sends `lite.start`. |
| `extensions.changed` | – | Fire the surface plugin's `extensionsChanged` (catalogue, badges or running state changed). |
| `settings.adopted` | `{userscripts?}` | Reserved for a dashboard-edited document coming back; not emitted on Lite today (**TBD**: wired when userscripts move to the coordinator). |
| `violentmonkey.connected` | – | Fire the `GeckoViolentmonkey` plugin's `connected` event. |
| `violentmonkey.dashboardChanged` | – | Fire its `dashboardChanged` event (Violentmonkey's storage changed outside a hand-off). |
| `log` | `{level: "log" \| "warn" \| "error", message}` | Forward to logcat under the Lite tag. |

Plus request `ui.confirm {title, message, detail, confirmLabel, cancelLabel}` → `{confirmed: boolean}` (an `AlertDialog` on the activity), and `ui.pickFile {}` → `{file?: string}` (the document picker for `*.xpi`/`*.zip`; `file` is whatever string `package.readArchive` accepts back, a content URI).

## Tabs

Java reports every reading WebView it owns; the broker never creates one
itself.

| Event (Java → broker) | Params |
| --- | --- |
| `tab.changed` | `{tabId, generation, targetId?, url, title, active, index, status: "loading" \| "complete", audible, muted}` — on creation and on any change. A new `generation` for the same `tabId` is a new tab (the old one is reported removed first). `targetId` once the WebView is attached. |
| `tab.removed` | `{tabId}` |

| Request (broker → Java) | Params | Result |
| --- | --- | --- |
| `tab.create` | `{url, active}` | `{tabId}` (after the `tab.changed` for it was sent) |
| `tab.update` | `{tabId, url?, active?, muted?}` | – |
| `tab.remove` | `{tabId}` | – |
| `tab.reload` | `{tabId}` | – |

`tabs.captureVisibleTab` is unsupported (the shared handler throws).
`tabs.move` is answered without moving. `windowId` is always `1`. A
`moz-extension://` URL passed to `tabs.create`/`tabs.update` opens an
extension page (`page.open`) instead of navigating a tab.

## Targets and DevTools events

Java attaches to every WebView through the browser endpoint
(`Target.setAutoAttach {autoAttach: true, waitForDebuggerOnStart: false, flatten: true}`)
and maps targets to WebViews by the `window.__onceLiteTab` marker it sets at
document start. For each target it reports:

| Event | Params |
| --- | --- |
| `target.attached` | `{targetId, kind: "tab" \| "page" \| "broker", tabId?, pageId?, frameTree?}` — `frameTree` is the `Page.getFrameTree` result (`{frame: {id, parentId?, url}, childFrames?}`) so frames that already exist are known. |
| `target.detached` | `{targetId}` |
| `cdp.event` | `{targetId, method, params}` — the DevTools event verbatim. |

Per attached tab and page target Java enables and forwards:

- `Page.enable`: `Page.frameAttached`, `Page.frameNavigated`, `Page.frameDetached`, `Page.navigatedWithinDocument`, `Page.domContentEventFired`, `Page.loadEventFired`.
- `Runtime.enable`: `Runtime.executionContextCreated` (the broker reads `context.id`, `context.name`, `context.auxData.{frameId,isDefault}`), `Runtime.executionContextDestroyed`, `Runtime.executionContextsCleared`, `Runtime.bindingCalled`.
- `Network.enable`: `Network.requestWillBeSent` (only ones carrying `redirectResponse` matter), `Network.loadingFinished`, `Network.loadingFailed`.
- `Fetch.enable {patterns: [{urlPattern: "*", requestStage: "Request"}, {urlPattern: "*", requestStage: "Response"}], handleAuthRequests: false}`: `Fetch.requestPaused`.

The broker target itself needs none of these. **TBD**: whether `Fetch.enable`
is issued once on the browser target (covers workers) or per page target; the
broker handles either since every `requestPaused` arrives with a `targetId`
(for a browser-level enable Java must resolve the target from `networkId`/the
session and may pass the owning tab's target id).

| Request (broker → Java) | Params | Result |
| --- | --- | --- |
| `cdp.command` | `{targetId, method, params?}` | The CDP result object, or a request error with the CDP error message. The broker uses `Fetch.continueRequest`, `Fetch.failRequest`, `Fetch.fulfillRequest`, `Fetch.continueResponse`, `Fetch.getResponseBody`, `Runtime.evaluate` (with `contextId`). |

Frames: Chromium frame ids stay strings between Java and the broker. The
broker exposes WebExtension frame ids: `0` for a target's top frame, a
stable positive integer per other frame it has met.

## Content worlds

| Request (broker → Java) | Params |
| --- | --- |
| `worlds.set` | `{registrations: [{worldName, source, binding}]}` — the full set, one per loaded extension. Java applies it to every current and future **tab** target: for each registration `Page.addScriptToEvaluateOnNewDocument {source, worldName, runImmediately: true}` and `Runtime.addBinding {name: binding, executionContextName: worldName}`; registrations no longer listed are removed with `Page.removeScriptToEvaluateOnNewDocument` (Java keeps the script identifiers). The set is resent whenever an extension loads, unloads or changes its content scripts (`contentScripts.register`, `scripting.registerContentScripts`). |

The `source` is the built `lite-world-bootstrap.js` followed by a boot call
with the extension's identity and every one of its content scripts (static
and registered), so matching happens in the world itself against
`location`/`window.top` (about:blank frames by their top URL under
`match_about_blank`) and injection is race-free for every frame kind.
`document_start` waits for `documentElement` as Electron does; CSS is
inserted as author-origin `<style>` elements; `tabs.executeScript`,
`insertCSS`, `removeCSS` and `scripting.*` arrive as `__content` events. The
world reads the bundle text through `onceLiteFiles.read("@bundle", "lite-world-bootstrap.js")`.

World → broker messages (the binding payload, JSON): `{host, type: "hello", url, topUrl, creatorUrl, matched}` when a frame's bootstrap starts (registers the context), `invoke {id, api, method, args}`, `listen {change}`, `reply {token, result}`, `main-eval {code}` (a scriptlet the page's `<meta>` policy refused, run by the broker in the frame's main world). Broker → world (`__onceLiteDeliver`): `{type: "result", id, result}` and `{type: "event", message}`.

`wrappedJSObject` in a world is a proxy whose `get`/`has`/`deleteProperty`
go through a synchronous DOM event channel to the main-world helper
(`lite-pip-main.js`, see below), scoped by the start token: the world
dispatches a `CustomEvent` on `document`, the helper answers in an attribute
on `documentElement`. Only JSON-representable values cross. Pages can
observe the channel (they can in Chrome's worlds too); they cannot forge the
token.

### Scriptlets and the document nonce

At the `Fetch` response stage of every `Document` request the broker adds
`'nonce-<n>'` to the page's `script-src` (or `script-src-elem`, else
`default-src`; untouched when `'unsafe-inline'` would be switched off by
it). `n = sha256(token + "|" + documentUrlWithoutFragment).slice(0, 32)`; the
world computes the same from `location.href` (its parent's for blank frames)
and stamps it on the inline `<script>` it inserts. A document with only a
`<meta>` policy refuses the script; the world detects that synchronously (a
marker the script sets) and sends `main-eval` instead.

## Extension pages

| Request (broker → Java) | Params | Result |
| --- | --- | --- |
| `page.open` | `{pageId, kind: "background" \| "popup" \| "options" \| "page", host, url, origin, documentStartSource}` | – (resolve once the WebView exists and the load started) |
| `page.close` | `{pageId}` | – |
| `page.post` | `{pageId, frameId, message}` | – (deliver `JSON.stringify(message)` through that frame's reply proxy) |
| `page.resize` | `{pageId, width, height}` | – (popups only; CSS pixels of the body) |

Java creates a WebView per `page.open`, installs
`addDocumentStartJavaScript(documentStartSource, [origin])` and
`addWebMessageListener("onceLitePage", [origin])`, sets a Firefox desktop
user agent for it (uBlock reads it), denies permission requests, and
serves `https://<host>.moz-extension.localhost/...` through the `Fetch`
interception (the broker fulfills those from the package; Java's
`shouldInterceptRequest` is only the Tier 2 fallback). Background pages are
kept in a 1×1 visible container (no timer throttling); popups are laid over
the toolbar and closed on outside tap; options and other pages are shown in
the shell's extension page frame.

| Event (Java → broker) | Params |
| --- | --- |
| `page.message` | `{pageId, frameId, mainFrame, url, message}` — `message` is the frame's parsed JSON. For frames of **tab** WebViews at an extension origin (uBlock's element picker) use `pageId: "tab:<tabId>"`. |
| `page.loaded` | `{pageId, url}` — the main frame's `onPageFinished`. |
| `page.closed` | `{pageId}` — the WebView was destroyed (by the user, `window.close()` or `page.close`). |
| `page.console` | `{pageId, level, message}` — console lines; errors and warnings are logged with the extension name. |

Page bootstrap (`lite-page-bootstrap.js`, prefixed by
`window.__onceLitePageInit = {id, host, kind, manifest, messages, uiLanguage};`)
→ broker: `{type: "invoke", id, api, method, args}`, `{type: "listen", change}`, `{type: "reply", token, result}`, `{type: "popup-size", width, height}`. Broker → page: `{type: "result", id, result: {ok, value | error}}`, `{type: "event", message}`.

`moz-extension://<host>/p` ↔ `https://<host>.moz-extension.localhost/p`:
`pageUrlFromExtensionUrl`, `extensionUrlFromPageUrl`, `pageHostOf`,
`pageOrigin` in `protocol.ts`; Java's `LiteExtensionPages.isExtensionUrl`
accepts both. Extension pages see the https form in `location` and the
`moz-extension` form from `runtime.getURL`; content worlds get the https
form from `runtime.getURL` so the URLs they put into the DOM load.

Tab WebViews must also get the page bootstrap for extension origins:
**TBD** — the broker will send `worlds.set` with an additional
`pages: [{host, origin, documentStartSource}]` list Java installs with
`addDocumentStartJavaScript(source, [origin])` on tab WebViews; until then
the element picker frame runs without `browser`.

## webRequest

`Fetch.requestPaused` (forwarded as a `cdp.event`) carries `requestId`,
`request {url, method, headers, postData?, hasPostData}`, `frameId`,
`resourceType`, `networkId`, `redirectedRequestId`, and at the response
stage `responseStatusCode`, `responseStatusText`, `responseHeaders`,
`responseErrorReason`. The broker:

1. Request stage: serves extension URLs itself (`Fetch.fulfillRequest`, web-accessible only from tabs, `Access-Control-Allow-Origin: *` on those); otherwise runs declarative rules then blocking `onBeforeRequest` (`Fetch.failRequest {errorReason: "BlockedByClient"}` / a 307 `fulfillRequest` for a redirect), then `onBeforeSendHeaders` plus header rules, and `Fetch.continueRequest {headers?}`; then notifies `onSendHeaders`.
2. Response stage: `onHeadersReceived` (blocking), the held `onResponseStarted` for documents (awaited while headers are held, as Electron does), header rules, the document nonce, the CORS grant for an extension page's permitted-host responses, and `Fetch.continueResponse {responseCode, responseHeaders}`; 3xx responses with `Location` are continued untouched and reported as `onBeforeRedirect` from `Network.requestWillBeSent`.
3. `Network.loadingFinished` → `onCompleted`; `Network.loadingFailed` → `onErrorOccurred`.

Resource types: `Document` → `main_frame`/`sub_frame` by frame position;
`Stylesheet, Image, Media, Font, Script, Ping` → themselves; `XHR, Fetch` →
`xmlhttprequest`; `WebSocket` → `websocket`; `CSPViolationReport` →
`csp_report`; `TextTrack, Prefetch, EventSource, Manifest, SignedExchange,
Preflight, Other` → `other`.

`filterResponseData`: the broker has a body-rewrite hook (`LiteWebRequest.addBodyFilter`)
that calls `Fetch.getResponseBody` and `fulfillRequest` with the rewritten
body (content-length/encoding dropped). The page-side `StreamFilter` shape
(`ondata`/`onstop`/`write`/`close`/`disconnect`) is **TBD**: today
`browser.webRequest.filterResponseData` throws a clear error. When wired,
the whole body is delivered in one `ondata` followed by `onstop`; streaming
is not possible over this round trip.

## Files and storage

`onceLiteFiles.read(directory, path)` (synchronous, broker WebView only):
`path` is extension-relative, normalised, no leading slash. Answers a JSON
string `{"text": "..."}` for text types (`.js .mjs .css .json .html .htm .txt .xml .svg .map`), `{"base64": "..."}` otherwise, or `null` when missing. `directory` may be a bundled asset directory, a package directory under `<storageRoot>/packages/<token>`, a staging directory, or `"@bundle"` for the built `lite-*.js` files from the web assets. **TBD**: a `files.preload {directory}` request answering `{files: {path: {text|base64}}}` for the manifest, locales and content scripts so loads never block on the interface; the reader already takes such a map.

JSON stores (one document per name, atomic replace via temp file + rename):
`store.read {directory, name}` → `{json: string | null}`; `store.write {directory, name, json}`. Directories: `<storageRoot>/manager` (`installed.json`), `<storageRoot>/<host>` (`storage.json`, `sync.json`, `dnr.json`, `once-filter-lists.json`, `once-relay-records.json`).

Packages: `files.mkdir {directory, path}`, `files.write {directory, path, base64}` (must refuse to overwrite), `files.remove {directory}`, `files.list {directory}` → `{entries: [names]}`; `package.fetch {url}` → `{status, headers, bodyBase64}` (HTTPS only, no credentials, redirects **not** followed — answer the 3xx so the broker re-requests; cap 33 MB); `package.readArchive {file}` → `{base64}`; `onceLiteFiles.unzip(token, archiveBase64)` unpacks with `java.util.zip` into `<storageRoot>/packages/.staging/<token>/`, refusing entries whose normalised path leaves it, and returns `{"entries": [{name, isDirectory, size}]}` (names `/`-separated, directories with a trailing slash); the broker then reads each entry back with `onceLiteFiles.read(stagingDirectory, name)` and writes it into the final directory through `files.write`, after the shared validation. Staging directories may be removed by Java on the next start. SHA-256 is computed in the broker.

## Cookies

`cookies.get {url?, name?, domain?, path?, secure?, session?}` → `{cookies: Network.Cookie[]}` (Java: `Network.getCookies` on the browser target, filtered); `cookies.set {url, name?, value?, domain?, path?, secure?, httpOnly?, expirationDate?, sameSite?}` (Java: `CookieManager.setCookie` with a Set-Cookie line built from the details, then `flush`); `cookies.remove {url, name}` (Java: `Network.deleteCookies {name, url}`); event `cookies.changed {removed, cookie, cause}` from Java (**TBD** mechanism: diffing `Network.getCookies` after writes and after `Network.responseReceivedExtraInfo` with `set-cookie`).

## Alarms and timers

The broker's `setTimeout` for delays ≥ 5 s is backed by Java (`timer.set {timerId, delayMs}` event, `timer.clear {timerId}` event, `timer.fired {timerId}` event back, Java using a `Handler` or `AlarmManager`-free `ScheduledExecutorService`), so `browser.alarms` and the long hand-off waits survive the hidden broker WebView's timer throttling. Java should still keep the broker WebView in a visible 1×1 container and never call `pauseTimers()`.

## i18n, platform, misc

`lite.start` carries `locale` (`Locale.getDefault().toLanguageTag()`) and `arch` (`Build.SUPPORTED_ABIS[0]` mapped to `arm`/`arm64`/`x86-64`); `os` is always `android`. `dns.resolve` is reserved (`dns.resolve {hostname}` → `{addresses}`) but not exposed to extensions yet (**TBD**). `privacy.*` is answered in the page bootstrap with Firefox defaults.

## Bridge world and main-world helper (Java-owned)

Java installs on every tab target, independently of the broker:

- `lite-bridge-world.js` in world `once-bridge` (`Page.addScriptToEvaluateOnNewDocument {worldName: "once-bridge", runImmediately: true}`), with `Runtime.addBinding {name: "onceLiteBridge", executionContextName: "once-bridge"}`, the source wrapped as `(function (ONCE_LITE_TOKEN) { <bundle> })("<token>")`. Messages to Java (binding payload, JSON) keep the Gecko names: `{type: "health", id, url, readyState, restored, context: null}`, `{id, value}` / `{id, error}` for `{id, code}` evaluations, `image-text`, `image-text-request`, `media-snapshot`, `pip-request`. Java delivers `{type: "health", id}`, `{id, code}`, `media-observe`, `media-command`, `pip-capability`, `pip-state`, `pip-result` with `Runtime.evaluate {expression: "__onceLiteBridgeDeliver(<json>)", contextId}` in the bridge context of the top frame (the world sends `health` first thing so Java learns the context id from `Runtime.bindingCalled`). `context` (the document provenance the Gecko background computed from webRequest) is `null` here; Java fills it from its own navigation record (**TBD** field shape).
- `lite-pip-main.js` in the main world (no `worldName`), wrapped the same way: the standard PiP polyfill (`requestPictureInPicture`, `exitPictureInPicture`, `pictureInPictureEnabled/Element`, the enter/leave events), the YouTube outer-size shim, and the `wrappedJSObject` answerer for content worlds. It talks to the bridge world only through token-scoped `CustomEvent`s on `document`.

## Java obligations, in build order

1. **Broker page**: load `https://localhost/lite-runtime.html` in a hidden WebView kept in a 1×1 visible container; `addWebMessageListener("onceLite")`, `addJavascriptInterface(files, "onceLiteFiles")` (`read`, `unzip`); on `broker.hello` send `lite.start`. Implement `log`, `timer.*`, `store.read/write`, `files.*`, `ui.confirm`, `ui.pickFile`. Wire `extensionCommand` → `extension.command`, `applyExtensionSettings` → `settings.apply`, `extensions.changed` → plugin event. (CDP: none.)
2. **DevTools fan-out**: on every tab/page WebView attach, send `target.attached` with `Page.getFrameTree`; enable `Page`, `Runtime`, `Network`, `Fetch` (patterns above) and forward the listed events as `cdp.event`; answer `cdp.command` by issuing the command on that target's session. Report tabs with `tab.changed`/`tab.removed` and answer `tab.create/update/remove/reload`.
3. **Worlds**: apply `worlds.set` to every tab target (`Page.addScriptToEvaluateOnNewDocument` + `Runtime.addBinding`, removal on change); forward `Runtime.bindingCalled` (already covered by 2).
4. **Extension pages**: `page.open/close/post/resize`, the `onceLitePage` listener per frame with numbered frames, `page.message/loaded/closed/console`, the Firefox user agent, popup placement and sizing, `page.open` for `kind: "page"`/`"options"` into the shell's extension page frame (`extensionPage` plugin contract).
5. **Violentmonkey plugin**: relay `send/handingOff/settled` to `violentmonkey.*` requests, map `NOT_RUNNING`, fire `connected`/`dashboardChanged` from the events.
6. **Packages**: `package.fetch` (HttpsURLConnection, manual redirects), `package.readArchive` (content resolver), `onceLiteFiles.unzip`.
7. **Cookies**: `cookies.get/set/remove` and `cookies.changed`.
8. **Bridge world and main helper** on tab targets with the Gecko-era handlers (`PageScriptCalls`, `ReadingPip`, `BackgroundMedia`, `ImageTextOverlays`) reading the binding instead of the native-messaging port.

## Deviations from Electron

- Listener registration (`addListener`) is asynchronous to the broker (Electron's is `sendSync`); ordering within a context is preserved, which is what the runtime relies on.
- Content worlds see https URLs from `runtime.getURL`; pages see `moz-extension://`.
- `wrappedJSObject` is JSON-only and observable by the page through the event channel.
- `extension.getBackgroundPage`/`runtime.getBackgroundPage` throw: the background page is another WebView.
- Scriptlets under a `<meta>`-only CSP run through DevTools main-world evaluation (not subject to the page CSP), slightly later than a `<script>` insertion would.
- `tabs.move` is a no-op; one window.
- Userscripts are not applied by the settings coordinator (see `settings.apply`).
