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
| `lite.start` (request) | `{bundled: [{id, directory, present}], locale, arch, token, storageRoot, devtools}` | `{ready: true, extensions: CatalogEntry[]}` | Once per broker page, after the broker's `broker.hello` event. `bundled` lists the shipped extensions (ids from `scripts/fetch-extensions.js`: `uBlock0@raymondhill.net` in `ublock-origin`, `{aecec67f-0d10-4fa7-b7c7-609a2db280cf}` in the plain `violentmonkey` bundle, **not** the Gecko-adapted `android/violentmonkey`); `directory` is whatever string `onceLiteFiles.read` resolves (an `asset:` prefix for APK assets is Java's own convention). `token` is a random secret (32+ hex chars) generated per app process and also given to the bridge/main helper scripts. `storageRoot` is the directory JSON stores live under (`<files>/lite-extensions`); `devtools` says whether Java holds a usable DevTools connection (false is Tier 2, see below); `ubolite` (`{id: "uBOLite@raymondhill.net", directory: "asset:extensions/ublock-origin-lite", present}`) is the bundle Tier 2 enforces. With DevTools the broker restores the catalogue, loads enabled extensions (opening their background pages) and installs the world registrations before answering; in Tier 2 it loads none and answers once Java has uBO Lite's rules and cosmetics (`net.rules`, `tier2.scripts`). |
| `extension.command` (request) | `{action, id?, source?, enabled?, file?}` | `{extensions?, cancelled?, noPage?}` | The shell's `extensionCommand` verbatim (`MobileExtensionCommand`). `list` answers the catalogue in the exact `MobileBrowserExtension` shape (`id, name, iconDataUrl?, description, version, enabled, bundled, hasOptions, hasAction, permissions, disabledReason`). `install {source}` previews an AMO listing/XPI URL, asks `ui.confirm`, installs. `chooseFile` asks `ui.pickFile` unless `file` is given, then the same (Java's plugin runs the picker itself and sends `chooseFile {file}`; `ui.pickFile` answers `{}`, which is a cancel). `enable {id, enabled}`, `remove {id}` (confirmed), `update {id}`, `options {id}` and `action {id}` (answer `noPage: true` when the extension has no such page; `action` without a popup fires `browserAction.onClicked`). Errors are answered as request errors; `code: "INVALID_SOURCE"` for a source that is neither AMO nor a file. |
| `extensions.list` (request) | – | `CatalogEntry[]` | The catalogue alone. |
| `settings.apply` (request) | `{filterLists, userscripts}` | – | The shell's `applyExtensionSettings` documents. Filter lists are handed to uBlock Origin through its dashboard port (`getLists`, `applyFilterListSelection`, `reloadAllFilters`, which uBlock answers after loading); the broker then asks `getLists` once more, which uBlock answers only with its lists in force, before answering this request (30 s bound). Userscripts are **not** applied here (the `GeckoViolentmonkey` hand-off below does that), see `liteSettings.ts`. |
| `violentmonkey.send` (request) | `{cmd, data?}` | `{value}` | `LiteViolentmonkeyPlugin.send`. Error `code: "NOT_RUNNING"` while Violentmonkey is not loaded. `OnceReadRecords`/`OnceWriteRecords` are answered from the Violentmonkey host's JSON store (`once-relay-records.json`); every other command is sent to Violentmonkey's background as a runtime message from a privileged `VirtualContext`. When Violentmonkey's background starts listening the broker sends it `SetOptions {xhrInject: true}` (synchronous page mode, as the Gecko relay did) and only then raises `violentmonkey.connected`. |
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

## Tier 2 (no DevTools)

When `lite.start` says `devtools: false` no extension loads and no world,
page or `Fetch` traffic exists. The broker (`liteTier2.ts`) compiles what
Java enforces itself, so the request path never waits for the broker:

| Request (broker → Java) | Params | Result |
| --- | --- | --- |
| `net.rules` | `{groups: [{id, directory?, rulesets?: [path], rules: DnrRule[]}]}` — the whole rule state. Group `ubolite`: uBO Lite's enabled rulesets by package path (`rulesets/main/<id>.json` and `rulesets/regex/<id>.json`, read by Java from `directory`; a missing file is skipped) plus its session rules inline. Group `once-lists`: the synced filter lists in the portable subset as block and allow rules. | `{counts: {group: rules}, skipped}` once the new evaluator is in force |
| `tier2.scripts` | `{sources: string[]}` — page-world sources, in order: the lists' generic cosmetics (one `<style>`), uBO Lite's generic cosmetic filtering, and when userscripts exist the `lite-tier2-page.js` runtime under a random key, one source per userscript, and the key's removal. Java registers each with `addDocumentStartJavaScript(source, ["*"])` on every reading tab, now and for tabs opened later, removing the previous set (`ScriptHandler.remove`); `addJavaScriptOnEvent` in world `once-tier2` where `JS_INJECTION_IN_FRAME_AND_WORLD` is supported. | – once registered on every tab |
| `tier2.fetchList` | `{url}` (http or https) | `{status, text?}` — the list's text for a 2xx, following redirects, 16 MB cap |

| Request (Java → broker) | Params | Result |
| --- | --- | --- |
| `net.sessionRules` | `{addRules?, removeRuleIds?}` — `declarativeNetRequest.updateSessionRules` for uBO Lite's group, validated by the shared rule parser (Tier 2 only; an error otherwise) | `net.rules`'s result after the push |

`settings.apply` in Tier 2 fetches the lists through `tier2.fetchList` (a
failed list is logged and left out), converts them, takes the userscripts
(either the synced `source` form or the shell's parsed `{body, matches,
includes, excludes, runAt, noFrames}` form), and answers after `net.rules`
and `tier2.scripts` did. `extension.command` answers `list` with uBO Lite
first (enabled, no options or popup), then the bundled and installed
extensions with `enabled: false` and `disabledReason: "Extensions limited:
DevTools unavailable"`; `options`/`action` for uBO Lite answer `noPage`, and
every other verb is refused with that message and code `LIMITED`.

Java's side (`LiteTier2.java`, `DnrEvaluator.java`): `shouldInterceptRequest`
of each reading tab builds the request (type from `Sec-Fetch-Dest` when
present, else the main-frame flag, `Accept`, `Range` and the extension;
initiator the tab's document), evaluates every group, and answers a block
with an empty 403, an `extensionPath` redirect with the package file
(`Access-Control-Allow-Origin: *`), and a URL redirect or `upgradeScheme` by
navigating a top-level document or fetching a subresource `GET` itself
(WebView takes no 3xx from the callback). An `allowAllRequests` match on the
document covers the tab's later requests. Static rulesets are compiled once
per process and cached in binary form per APK install
(`files/lite-extensions/tier2-rules/`).

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

Tab main-frame documents are held at the `Fetch` request stage while the
Violentmonkey hand-off is in progress (`violentmonkey.handingOff` … `settled`)
and, after uBlock Origin loads, until its background answers `getLists` for
the first time (its start-up has loaded the lists by then; 20 s bound): a
document let through earlier would go unfiltered, since uBlock's own
suspending listener holds requests longer than the router's blocking timeout.

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

The broker target itself needs none of these. `Fetch.enable` is issued per
page target (LiteDevToolsTest proved it there; workers are not covered yet).
Every `requestPaused` arrives with a `targetId`.

| Request (broker → Java) | Params | Result |
| --- | --- | --- |
| `cdp.command` | `{targetId, method, params?}` | The CDP result object, or a request error with the CDP error message. The broker uses `Fetch.continueRequest`, `Fetch.failRequest`, `Fetch.fulfillRequest`, `Fetch.continueResponse`, `Fetch.getResponseBody`, `Runtime.evaluate` (with `contextId`). |

Frames: Chromium frame ids stay strings between Java and the broker. The
broker exposes WebExtension frame ids: `0` for a target's top frame, a
stable positive integer per other frame it has met.

## Content worlds

| Request (broker → Java) | Params |
| --- | --- |
| `worlds.set` | `{registrations: [{worldName, source, binding}], pages: [{host, origin, documentStartSource}]}` — the full set, one per loaded extension. Java applies it to every current and future **tab** target: for each registration `Page.addScriptToEvaluateOnNewDocument {source, worldName, runImmediately: true}` and `Runtime.addBinding {name: binding, executionContextName: worldName}`; registrations no longer listed are removed with `Page.removeScriptToEvaluateOnNewDocument` (Java keeps the script identifiers). The set is resent whenever an extension loads, unloads or changes its content scripts (`contentScripts.register`, `scripting.registerContentScripts`). |

The `source` is the built `lite-world-bootstrap.js` followed by a boot call
with the extension's identity and every one of its content scripts (static
and registered), so matching happens in the world itself against
`location`/`window.top` (about:blank frames by their top URL under
`match_about_blank`) and injection is race-free for every frame kind.
`document_start` waits for `documentElement` as Electron does; CSS is
inserted as author-origin `<style>` elements; `tabs.executeScript`,
`insertCSS`, `removeCSS` and `scripting.*` arrive as `__content` events. The
world reads the bundle text through `onceLiteFiles.read("@bundle", "lite-world-bootstrap.js")`.

Scripts run with a sandbox object as `this` rather than the world's global,
through a direct `eval` in a sloppy function (a script's completion value is
what `tabs.executeScript` answers; top-level declarations are local to the
script). The sandbox forwards to the world's global: reads with the global
as receiver (the window's accessors refuse any other) and its native methods
bound to it, writes and definitions onto the global, and a name the world
does not have is read from the page through `wrappedJSObject`. Its `window`,
`self`, `top` and the like are the sandbox itself. Bare names resolve to the
world's globals through the scope chain as usual. Violentmonkey hands `this`
to userscripts as `unsafeWindow`, so a content-mode userscript reads page
globals through it while it stays distinct from the world's `window`; its
browser detection (`this !== this.window` means Firefox) keeps it on its
Chrome path, whose page bridge needs no xray wrappers (`exportFunction` and
`cloneInto` are identity shims all the same).
A `tabs.executeScript {runAt:
"document_start"}` call for a document the broker is still holding at the
response stage (Firefox queues it for the coming document) is queued into
that document's per-document `/_once/dynamic` answer instead of being
delivered to a context that does not exist yet; it answers `[null]`.

World → broker messages (the binding payload, JSON): `{host, type: "hello", url, topUrl, creatorUrl, matched}` when a frame's bootstrap starts (registers the context), `invoke {id, api, method, args}`, `listen {change}`, `reply {token, result}`, `main-eval {code}` (a scriptlet the page's `<meta>` policy refused, run by the broker in the frame's main world). Broker → world (`__onceLiteDeliver`): `{type: "result", id, result}` and `{type: "event", message}`.

### Synchronous answers (registered scripts, Violentmonkey's blobs)

Every WebView of the app shares one renderer main thread, so a request that
blocks a tab (a synchronous `XMLHttpRequest` at document start) can never
be answered by the broker, which runs in that renderer too. Answers a world
needs synchronously are therefore prepared by the broker ahead of time and
served by **Java** from memory at the `Fetch` request stage, never
forwarded: `sync.set {host, path, body | null}` stores (or forgets) the JSON
text Java fulfils for `https://<host>.moz-extension.localhost<path>` (200,
`application/json`, `Cache-Control: no-store`, `Access-Control-Allow-Origin: *`;
404 when nothing is stored; blob answers are served once). The broker
flushes them before it continues a document's response.

- `/_once/dynamic?u=<document URL without fragment>`: the extension's
  scripts registered at run time (`contentScripts.register`, `scripting.*`)
  plus the `executeScript` calls queued for that document, as
  `{host, scripts: WorldScript[], cookie?}`. The world bootstrap asks for
  them with a synchronous request at document start (for `http(s)` documents
  only) and matches and schedules them like the manifest's, so uBlock's
  scriptlets, registered during the document's held `onResponseStarted`,
  run before the page's own scripts. Java serves an entry stored under the
  full URL (one document, served once) before the host's path entry. The
  document's `connect-src` (or `default-src`) is widened to the extension
  origins so the request passes the page's policy. Registrations are
  **not** re-installed through `Page.addScriptToEvaluateOnNewDocument` for
  this: a DevTools command on a target whose navigation is paused does not
  return.
- `/_once/blob/<id>`: Violentmonkey's synchronous injection. Its
  `onHeadersReceived` listener adds `Set-Cookie: <host>=<blob id>` to a
  document it prepared scripts for (from `onSendHeaders`, which the broker
  raises before the request goes on; the listener is asked again a few
  times, 25 ms apart, when the headers beat its preparation), in a blob of
  its own origin. The broker reads that blob through the background page
  (`__liteBlob` event over the page channel, answered with its text) and
  hands it to Java under the id before the document continues, together
  with the document's `/_once/dynamic` entry carrying `cookie:
  "<host>=<id>"`, which the world sets on the document at document start:
  Chromium does not store a `Set-Cookie` added through `Fetch.continueResponse`.
  The content world's request for `blob:<origin>/<id>` (either form of the
  origin) is rewritten to this path by the world bootstrap, since a blob URL
  is origin-bound in Chromium.

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
marker the script sets) and sends `main-eval` instead. The world stamps the
nonce through patched `createElement` and `createElementNS` so scripts the
extensions create (uBlock's scriptlet injector) carry it too.

Chromium enforces the policy of the **original** response headers, not the
ones passed to `Fetch.continueResponse`. A document whose policy the broker
changed (nonce, `connect-src` widening, an extension's `onHeadersReceived`
edit) is therefore re-delivered: `Fetch.getResponseBody` and
`Fetch.fulfillRequest` with the edited headers (`content-length`,
`content-encoding` and `transfer-encoding` dropped). Unchanged documents
are continued as usual.

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
`moz-extension` form from `runtime.getURL`; the page bootstrap maps
`moz-extension://` URLs the page hands to `fetch`, `Request`,
`XMLHttpRequest.open`, `navigator.sendBeacon`, the `src`/`href` setters of
images, scripts, frames, media, sources, links and anchors, and
`setAttribute("src"|"href")` to the https form, since the WebView cannot load
the scheme. Content worlds get the https form from `runtime.getURL` so the
URLs they put into the DOM load. Every page message carries `href`, the
frame's `location.href`, because Java knows only a subframe's origin; the
broker takes it as the frame's URL when its host matches.

Own-page requests the broker fulfils (the extension's files to its own
WebViews, and its reads of `moz-extension://` URLs, which Chromium treats as
another origin than the https one) carry Electron's CORS grant:
`Access-Control-Allow-Origin: https://<host>.moz-extension.localhost`,
`-Credentials: true`, `-Headers/-Methods/-Expose-Headers: *`. Web-accessible
resources served to tabs carry `Access-Control-Allow-Origin: *`.

Tab WebViews also get the page bootstrap for extension origins: `worlds.set`
carries `pages: [{host, origin, documentStartSource}]` (kind `page`), which
Java installs with `addDocumentStartJavaScript(source, [origin])` on every
tab WebView, and `LitePage.listenInTab` carries those frames' messages as
`pageId: "tab:<tabId>"`.

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
`store.read {directory, name}` → `{json: string | null}`; `store.write {directory, name, json}` (whole document);
`store.patch {directory, name, set: {key: jsonText}, remove: [keys]}` (Java merges the top-level keys into the
document on disk, splitting it one level deep into key → raw text once and keeping that map between patches, so
uBlock's tens of megabytes are never parsed into an object tree). The broker writes a plain-object document whole
the first time and as patches of the keys whose JSON text changed afterwards; a failed patch makes the next write whole. Directories: `<storageRoot>/manager` (`installed.json`), `<storageRoot>/<host>` (`storage.json`, `sync.json`, `dnr.json`, `once-filter-lists.json`, `once-relay-records.json`).

Packages: `files.mkdir {directory, path}`, `files.write {directory, path, base64}` (must refuse to overwrite), `files.remove {directory}`, `files.list {directory}` → `{entries: [names]}`; `package.fetch {url}` → `{status, headers, bodyBase64}` (HTTPS only, no credentials, redirects **not** followed — answer the 3xx so the broker re-requests; cap 33 MB); `package.readArchive {file}` → `{base64}`; `onceLiteFiles.unzip(token, archiveBase64)` unpacks with `java.util.zip` into `<storageRoot>/packages/.staging/<token>/`, refusing entries whose normalised path leaves it, and returns `{"entries": [{name, isDirectory, size}]}` (names `/`-separated, directories with a trailing slash); the broker then reads each entry back with `onceLiteFiles.read(stagingDirectory, name)` and writes it into the final directory through `files.write`, after the shared validation. Staging directories may be removed by Java on the next start. SHA-256 is computed in the broker.

## Cookies

`cookies.get {url?, name?, domain?, path?, secure?, session?}` → `{cookies: Network.Cookie[]}` (Java: `Network.getCookies` on the broker page's session, the browser target does not take `Network.*`, filtered); `cookies.set {url, name?, value?, domain?, path?, secure?, httpOnly?, expirationDate?, sameSite?}` (Java: `CookieManager.setCookie` with a Set-Cookie line built from the details, then `flush`); `cookies.remove {url, name}` (Java: `Network.deleteCookies {name, url}`); event `cookies.changed {removed, cookie, cause}` from Java (diffing `Network.getCookies` after its own writes and after a `Network.responseReceivedExtraInfo` carrying `set-cookie`).

## Alarms and timers

The broker's `setTimeout` for delays ≥ 5 s is backed by Java (`timer.set {timerId, delayMs}` event, `timer.clear {timerId}` event, `timer.fired {timerId}` event back, Java using a `Handler` or `AlarmManager`-free `ScheduledExecutorService`), so `browser.alarms` and the long hand-off waits survive the hidden broker WebView's timer throttling. Java should still keep the broker WebView in a visible 1×1 container and never call `pauseTimers()`.

## i18n, platform, misc

`lite.start` carries `locale` (`Locale.getDefault().toLanguageTag()`) and `arch` (`Build.SUPPORTED_ABIS[0]` mapped to `arm`/`arm64`/`x86-64`); `os` is always `android`. `dns.resolve` is reserved (`dns.resolve {hostname}` → `{addresses}`) but not exposed to extensions yet (**TBD**). `privacy.*` is answered in the page bootstrap with Firefox defaults.

## Bridge world and main-world helper (Java-owned)

Java installs on every tab target, independently of the broker:

- `lite-bridge-world.js` in world `once-bridge` (`Page.addScriptToEvaluateOnNewDocument {worldName: "once-bridge", runImmediately: true}`), with `Runtime.addBinding {name: "onceLiteBridge", executionContextName: "once-bridge"}`, the source wrapped as `(function (ONCE_LITE_TOKEN) { <bundle> })("<token>")`. Messages to Java (binding payload, JSON) keep the Gecko names: `{type: "health", id, url, readyState, restored, context: null}`, `{id, value}` / `{id, error}` for `{id, code}` evaluations, `image-text`, `image-text-request`, `media-snapshot {url, title, artist, playing, duration, position, rate, seekable, videoWidth, videoHeight}` (sent while `media-observe {enabled: true}` is in force, throttled to one a second except on play/pause; `playing: false` on pagehide), `pip-request`. Java delivers `{type: "health", id}`, `{id, code}`, `media-observe {enabled, pictureInPicture}`, `media-command {action: "play" | "pause" | "seek", position?, url?}` (`url`, when given, must be the document's), `pip-capability`, `pip-state`, `pip-result` with `Runtime.evaluate {expression: "__onceLiteBridgeDeliver(<json>)", contextId}` in the bridge context of the top frame (the world sends `health` first thing so Java learns the context id from `Runtime.bindingCalled`). `context` (the document provenance the Gecko background computed from webRequest) is `null` here; Java fills it from its own navigation record (**TBD** field shape).
- `lite-pip-main.js` in the main world (no `worldName`), wrapped the same way: the standard PiP polyfill (`requestPictureInPicture`, `exitPictureInPicture`, `pictureInPictureEnabled/Element`, the enter/leave events), the YouTube outer-size shim, and the `wrappedJSObject` answerer for content worlds. It talks to the bridge world only through token-scoped `CustomEvent`s on `document`.

## Java obligations, in build order

1. **Broker page**: load `https://localhost/lite-runtime.html` in a hidden WebView kept in a 1×1 visible container; `addWebMessageListener("onceLite")`, `addJavascriptInterface(files, "onceLiteFiles")` (`read`, `unzip`, `writeChunk`, `readChunk`); on `broker.hello` send `lite.start`. Implement `log`, `timer.*`, `store.read/write/patch` (chunked values and reads), `files.*`, `ui.confirm`, `ui.pickFile`, `sync.set`. Wire `extensionCommand` → `extension.command`, `applyExtensionSettings` → `settings.apply`, `extensions.changed` → plugin event. (CDP: none.)
2. **DevTools fan-out**: on every tab/page WebView attach, send `target.attached` with `Page.getFrameTree`; enable `Page`, `Runtime`, `Network`, `Fetch` (patterns above) and forward the listed events as `cdp.event`; answer `cdp.command` by issuing the command on that target's session. Report tabs with `tab.changed`/`tab.removed` and answer `tab.create/update/remove/reload`.
3. **Worlds**: apply `worlds.set` to every tab target (`Page.addScriptToEvaluateOnNewDocument` keyed by registration `id`, `runImmediately` only when the target is first bound, `Runtime.addBinding` once per world, removal on change); send `target.attached` and the queued events before installing them (a script run immediately may make a synchronous request only Java answers); answer `https://<host>.moz-extension.localhost/_once/…` requests from the `sync.set` store at the Fetch request stage without forwarding them; forward `Runtime.bindingCalled` (already covered by 2).
4. **Extension pages**: `page.open/close/post/resize`, the `onceLitePage` listener per frame with numbered frames, `page.message/loaded/closed/console`, the Firefox user agent, popup placement and sizing, `page.open` for `kind: "page"`/`"options"` into the shell's extension page frame (`extensionPage` plugin contract).
5. **Violentmonkey plugin**: relay `send/handingOff/settled` to `violentmonkey.*` requests, map `NOT_RUNNING`, fire `connected`/`dashboardChanged` from the events.
6. **Packages**: `package.fetch` (HttpsURLConnection, manual redirects), `package.readArchive` (content resolver), `onceLiteFiles.unzip`.
7. **Cookies**: `cookies.get/set/remove` and `cookies.changed`.
8. **Bridge world and main helper** on tab targets with the Gecko-era handlers (`PageScriptCalls`, `ReadingPip`, `BackgroundMedia`, `ImageTextOverlays`) reading the binding instead of the native-messaging port.

## Deviations from Electron

- Listener registration (`addListener`) is asynchronous to the broker (Electron's is `sendSync`); ordering within a context is preserved, which is what the runtime relies on.
- Content worlds see https URLs from `runtime.getURL`; pages see `moz-extension://`.
- `wrappedJSObject` is JSON-only and observable by the page through the event channel.
- `extension.getBackgroundPage` returns `null` and `runtime.getBackgroundPage` resolves `null` (as Firefox answers where the page is out of reach): the background page is another WebView; Violentmonkey's pages then fall back to `runtime.sendMessage`.
- Scriptlets under a `<meta>`-only CSP run through DevTools main-world evaluation (not subject to the page CSP), slightly later than a `<script>` insertion would.
- `tabs.move` is a no-op; one window.
- Userscripts are not applied by the settings coordinator (see `settings.apply`).
- Extension pages: `moz-extension://` URLs are mapped to https in the request and element APIs listed above; code that compares such URLs with `location` must map one side (`location` is https).
- Violentmonkey runs in synchronous page mode (`xhrInject`), its blobs read through the broker; Electron's worlds read them directly. Its `Set-Cookie` blob name reaches the document through the per-document answer, not the cookie jar.
- Content scripts run with a sandbox `this` and a direct `eval` (see Content worlds): `this !== window`, `this.window === this`, unknown names read from the page; `exportFunction`/`cloneInto` are identity shims.
- Documents whose policy the broker changes are re-delivered with `Fetch.fulfillRequest` (body re-read through DevTools), since Chromium ignores header edits from `Fetch.continueResponse` for CSP.
- The catalogue lists bundled extensions first, in bundle order (uBlock Origin, Violentmonkey), then installed ones in install order.
