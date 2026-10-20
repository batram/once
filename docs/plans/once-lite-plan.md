# Plan: Once Lite, the Android app without GeckoView

Status: in progress (started 2026-10-19). Milestones below record what is done.

Once Lite is a second Android app beside the GeckoView-based one. Its reading
surface is the system `android.webkit.WebView`, so the APK is tens of MB
instead of Firefox-sized and the engine updates with the OS. It has every
feature of the GeckoView app, including browser extensions: Once's own runtime
for the Firefox flavour of WebExtensions (the same runtime design Electron
already uses on Chromium) hosts uBlock Origin, Violentmonkey and
user-installed XPIs on top of the WebView. The two apps install side by side
(`com.zmarn.once` and `com.zmarn.once.lite`, dev variants with `.dev`).

## Decision: Chrome DevTools Protocol is the privilege boundary

Android WebView has no extension subsystem and the public `WebViewClient`
surface is too narrow for uBlock Origin (no request bodies, no response header
edits, no isolated worlds, no response-body filtering). Chromium does ship all
of that behind the DevTools protocol, and WebView exposes it on an abstract
Unix socket (`webview_devtools_remote_<pid>`) once
`WebView.setWebContentsDebuggingEnabled(true)` is set. Chromium's socket
authorisation admits the same uid, so the app can attach to its own WebViews.

Verified on the API 36 emulator (WebView 133) on 2026-10-19 against the Once
Dev shell WebView, from the host over `adb forward`:

| Need | CDP mechanism | Verified |
| --- | --- | --- |
| Blocking `webRequest` with resource type, POST body, request headers | `Fetch.enable` at `Request` stage: `requestPaused` carries `resourceType` (`XHR`, `Image`, `Document`...), `request.postData`, headers; `continueRequest` with edited headers, `failRequest(BlockedByClient)`, `fulfillRequest` | yes: image blocked, iframe document replaced, header added |
| `onHeadersReceived` with header edits | `Response` stage `requestPaused` with `responseHeaders`; `continueResponse`/`fulfillRequest` | yes |
| `filterResponseData` | `Fetch.getResponseBody` at response stage, then `fulfillRequest` with the rewritten body | yes: XHR body rewritten |
| CORS preflights, redirects | preflight `OPTIONS` seen as its own paused request | yes |
| Content scripts in isolated worlds at `document_start`, all frames | `Page.addScriptToEvaluateOnNewDocument({worldName, runImmediately})`; `Page.createIsolatedWorld` for existing documents | yes: world does not see main-world globals |
| Content script to host messaging | `Runtime.addBinding({name, executionContextName})`: the binding exists only in that world; `Runtime.bindingCalled` carries the context id | yes |
| Host to content script | `Runtime.evaluate`/`callFunctionOn` with the world's `contextId` (from `Runtime.executionContextCreated`, `auxData.frameId`/`name`) | yes |
| Main-world scriptlets before page scripts | `Page.addScriptToEvaluateOnNewDocument` without a world, or `Runtime.evaluate` in the main context; DevTools evaluation is not subject to the page CSP | yes |
| Many WebViews, one connection | browser endpoint `/devtools/browser` with `Target.setAutoAttach(flatten)`; every WebView is a `page` target; `Target.getTargets` lists them | yes |
| Workers | `Fetch.enable` on the browser target covers every frame, worker and service worker in the process (Chromium `devtools_instrumentation.cc`); CORS preflights are the one request kind DevTools does not pause | source-verified |

Cost: every intercepted request pays one round trip through the app's own
socket (uBlock on Firefox pays a parent-process IPC for the same thing).
`setWebContentsDebuggingEnabled` is process-wide and stays on in release
builds of Once Lite; only the same uid, shell and root may connect, so the
exposure is the existing "USB debugging enabled" one. The setting is
reported in Settings beside Allow Web Inspector.

Chromium findings that shape the details (full report: the WebView research
of 2026-10-19): the socket admits root, shell and the WebView host's own uid;
WebView runs a single renderer with no site isolation, so one page target sees
all its iframes; `Target.createTarget` is unavailable on WebView (the app
creates WebViews itself); `shouldInterceptRequest` is never called for
redirect hops and never sees request bodies, which is why Tier 1 uses `Fetch`.

Where CDP cannot be attached (a WebView provider too old for the `Fetch`
domain, a missing socket) the app falls back to a degraded tier, see
"Tier 2" below. Nothing else is impossible; the compatibility matrix in
`docs/EXTENSION_COMPATIBILITY.md` records the Lite column as work lands.

## Architecture

```
Capacitor shell WebView (unchanged Once UI, https://localhost/)
   │ Capacitor plugins (same names and contract as the GeckoView app)
Java: LiteSurfacePlugin (InAppBrowserSurface), LiteViolentmonkeyPlugin
      (GeckoViolentmonkey name kept), NativeDatabase, SecureSettings, ...
   │
   ├─ reading WebViews, one per tab  ─────────────┐
   ├─ extension page WebViews (popups, options) ──┤ all targets of one
   ├─ background WebViews, one per extension ─────┤ DevTools connection
   └─ runtime WebView (hidden): the broker ───────┘ (DevToolsClient, Java)
```

- **Broker** (`apps/mobile/src/lite/runtime*.ts`, loaded in a hidden WebView):
  the platform-neutral half of the Electron runtime, now in
  `packages/webext-runtime`: extension hosts, contexts, ports, the API handler
  table, `WebRequestRouter` fan-out, DNR enforcement, storage, settings
  adapters for uBlock and Violentmonkey (`VirtualContext`), the AMO package
  flow. It talks to Java over a `WebMessageListener` channel (`onceLite`)
  with a small typed protocol: Java forwards CDP events (`requestPaused`,
  `executionContextCreated`, `bindingCalled`, navigation) and shell commands;
  the broker answers with CDP commands to issue (`fulfill`, `continue`,
  `evaluate in context`, `addScriptToEvaluateOnNewDocument`) and host
  commands (`create tab`, `show popup`, `read file`, `write storage`). The
  broker never touches the network or files itself; Java does, so the broker
  is unit-tested in Node with fake transports.
- **DevToolsClient** (Java): connects to the app's own socket, attaches to
  the browser target with `Target.setAutoAttach`, maps each WebView to its
  target by a unique initial `about:blank#once-<id>` load, multiplexes
  sessions, and forwards the events the broker subscribed to. Falls back to
  Tier 2 when the connection fails or the `Fetch` domain is refused.
- **Content worlds**: per extension and tab target, one
  `addScriptToEvaluateOnNewDocument` registration in world
  `once-ext:<host>` (androidx.webkit 1.16's `addJavaScriptOnEvent` with a
  `JavaScriptExecutionWorld` and the per-world `addWebMessageListener` are the
  same primitive without DevTools, used where the installed WebView reports
  `JS_INJECTION_IN_FRAME_AND_WORLD`; the emulator's WebView 133 does not): it bootstraps `browser`/`chrome` (`PreloadApi` over a
  binding transport), evaluates the extension's content-script matcher
  against `location`/`window.top`, and schedules the matching scripts at
  `document_start`/`document_end`/`document_idle`. Carrying every static
  content script in the registration keeps injection race-free for every
  frame kind (`about:blank`, `srcdoc`, bfcache); V8 pre-parses the unmatched
  bodies lazily. Dynamic registrations replace the registration. CSS goes
  through `CSS.addRule`-free `<style>` insertion from the world (same as
  Electron's author-origin sheets).
- **Scriptlets and page CSP**: a DevTools-created world has no CSP of its
  own, so a `<script>` inserted from it is judged by the page's CSP (Electron
  gives the world an empty CSP instead). Lite adds a per-document nonce to
  the page's `script-src` at the response stage of every document request
  and the world bootstrap stamps that nonce on inline scripts the content
  script inserts. A document with a `<meta>` CSP and no header gets its
  scriptlets through main-world evaluation instead. Both paths are tested
  against a strict-CSP fixture.
- **Extension pages** load at `https://<host>.moz-extension.localhost/...`
  in dedicated WebViews whose `shouldInterceptRequest` serves the unpacked
  package (`serveExtensionRequest`); the broker's `PreloadApi` is injected at
  document start and talks over a `WebMessageListener`. A custom
  `moz-extension://` scheme is not usable: WebView enables Chromium's
  non-standard-scheme hack, which discards the host from such origins
  (`url/scheme_host_port.cc` `ShouldDiscardHostAndPort`), so every extension
  would share one insecure origin. `*.localhost` is loopback and a secure
  context, each host is its own tuple origin with its own storage and
  service-worker scope, and interception happens before DNS. The `browser.*`
  shim keeps `runtime.getURL` and friends on the `moz-extension://<host>/`
  form (Violentmonkey detects Firefox by the `moz-` prefix) and the host maps
  both forms when navigating, serving, and matching `web_accessible_resources`;
  `location` inside extension pages is the https form, which the compatibility
  doc records. Network requests from extension pages are fulfilled by Java
  through the `Fetch` domain with the extension's host permissions, adding the
  `Access-Control-Allow-Origin` Chromium's CORS layer still checks on a
  fulfilled response (Electron's CORS grant does the same).
- **Background pages** are kept `View.VISIBLE` in a 1x1 container (or never
  attached) so Blink does not apply intensive wake-up throttling; `alarms`
  are driven natively. `WebView.pauseTimers()` is process-wide and is never
  called.
- **Tabs**: a reading WebView per tab, owned by `LiteSurfacePlugin` with the
  same tab/generation routing, events and recovery contract as the GeckoView
  plugin (`WebViewClient`/`WebChromeClient` callbacks map onto
  `navigationStarted/Committed/Finished/Failed`, `historyChanged` from the
  `WebBackForwardList`, `onRenderProcessGone` recovery, `findAllAsync`,
  `HitTestResult` long-press menus, `onShowCustomView` fullscreen and PiP,
  `DownloadListener`, `shouldOverrideUrlLoading` for intent links, desktop
  site through user agent and viewport settings).
- **Once's own page features** (source picker evaluation, image text,
  media snapshots, standard PiP polyfill) run in a Once-owned world
  (`once-bridge`) instead of the Gecko bridge extension; the content scripts
  are shared where they do not use Gecko xray APIs, and the PiP polyfill
  gets a main-world variant.
- **Synced filter lists and userscripts** reach uBlock and Violentmonkey the
  Electron way (dashboard message APIs through `VirtualContext`), so the
  Android bridge extension's portable-subset filtering is not needed on Lite;
  `applyExtensionSettings` and the `GeckoViolentmonkey` hand-off keep their
  JS contract.
- **Management**: AMO install with the listing-hash check and the package
  validation from `ExtensionPackage`, local XPIs through the document picker,
  enable/disable/remove, options and action pages, the same native prompts.
  Mozilla signatures are not verified cryptographically (as on Electron); the
  catalogue says so.

## Tier 2: WebView without DevTools

If the DevTools connection cannot be established the surface still works and
reports "extensions limited" in Settings → Browser Extensions. Tier 2 keeps:
synced filter lists through `shouldInterceptRequest` (type inferred from
`Sec-Fetch-Dest`/`Accept`), cosmetic CSS and userscripts through
`addJavaScriptOnEvent` in an isolated world where the WebView supports it,
else `addDocumentStartJavaScript` (page world, closure-scoped GM shim as on
iOS), and uBlock Origin Lite's declarative rules, compiled by the broker and
evaluated by Java's port of the DNR matcher in the interception callback (a
broker round trip per request would block on the renderer the tab shares
with the broker). Full extensions are not loaded in Tier 2.

## Identity and build

- Gradle gains a second flavour dimension `engine` with `gecko` and `lite`.
  Variants: `geckoDevelopment`, `geckoProduction`, `liteDevelopment`,
  `liteProduction`. Lite's `applicationIdSuffix` is `.lite` (so
  `com.zmarn.once.lite` and `com.zmarn.once.lite.dev`), names "Once Lite" and
  "Once Lite Dev", its own launcher icon. The GeckoView dependency, the Gecko
  asset task and the Gecko Java sources move to `src/gecko`; Lite sources
  live in `src/lite`; `src/main` keeps what both share. `MainActivity`
  registers the engine's plugins through `EngineSurface.register`, a class
  each flavour provides.
- `capacitor.config.ts`, `mobile-cli.js`, the e2e runner, wdio, device
  helpers, CI and docs take `ONCE_MOBILE_ENGINE=gecko|lite` (default gecko),
  and the APK paths move to `apk/<engine><Environment>/debug/`.
- The web bundle is shared; the broker and world bootstraps are additional
  webpack entries built for every Android build.

## Milestones

- **M1** (done 2026-10-19) Shared runtime package `packages/webext-runtime` extracted from
  `apps/electron/src/extensions` (Electron keeps its adapters and all its
  tests). Done 2026-10-19 for the package: `@once/webext-runtime` holds the
  host-neutral runtime behind the interfaces in its `README.md`
  (`ExtensionFileReader`, `JsonStore`, `CookieStore`, `RuntimePlatform`,
  `ExtensionPackageHost`, `ExtensionShellHooks`, `ContextEntry` transports,
  the per-stage `WebRequestRouter`), with `@once/webext-runtime/preload` for
  page bundles and `@once/webext-runtime/node` for the Node adapters;
  Electron's `apps/electron/src/extensions` is down to its adapters. Lite flavour, WebView surface with the full plugin contract minus
  extensions, `DevToolsClient` with an instrumentation test proving the
  in-process attach and the `Fetch`/world primitives, e2e harness running
  the smoke phases against Lite. Findings: the in-process DevTools attach,
  `Fetch` interception, isolated worlds and bindings all passed on the API 36
  emulator (`LiteDevToolsTest`); `Page.enable` is required before
  `Runtime.bindingCalled` arrives; the synthetic `*.moz-extension.localhost`
  origins are secure contexts with separate storage and the usual CORS; the
  WebView 133 provider lacks `JS_INJECTION_IN_FRAME_AND_WORLD`;
  `shouldInterceptRequest` on API 36 does not pass `Sec-Fetch-Dest`, so Tier 2
  infers types from `Accept`. The Lite debug APK is 48 MB against 248 MB.
- **M2** Lite extension runtime: broker, hosts, background pages, content
  worlds, webRequest and DNR through `Fetch`, extension pages and popups,
  storage, settings adapters, management. uBlock Origin and Violentmonkey
  run as bundled extensions.
- **M3** Tests and docs: broker unit tests, Lite e2e phases (blocking,
  cosmetic, scriptlets under strict CSP, userscript at document start with
  GM API, popup and options pages, synced lists, AMO install opt-in),
  `EXTENSION_COMPATIBILITY.md`, `ARCHITECTURE.md`, `DEVELOPMENT.md`,
  `RELEASING.md`, CI job.
- **M4** (done 2026-10-20) Tier 2 fallback and its tests. The broker
  starts without DevTools, loads no extension and compiles the rules and
  page scripts Java applies on its own (`liteTier2.ts`, the
  `net.rules`/`tier2.scripts`/`tier2.fetchList`/`net.sessionRules` messages
  of the protocol doc): uBlock Origin Lite's default rulesets (about 112k
  rules from the vendored Safari build, which carries them, so no Chromium
  build is pinned), its session rules and the synced lists in the portable
  subset, evaluated by a Java port of the DNR matcher with a token index
  (`DnrEvaluator.java`, about 40 µs a request on the JVM) from
  `shouldInterceptRequest`; the lists' and uBO Lite's generic cosmetics and
  the synced userscripts with the iOS GM shim through
  `addDocumentStartJavaScript` (`tier2Page.ts`). Findings: WebView refuses
  3xx responses from `shouldInterceptRequest`, so redirects to URLs
  navigate or are fetched by Java; compiling the 112k rules from JSON takes
  5 to 11 s in the debuggable build on the emulator, so the compiled rules
  are cached per install (0.4 s to read back); the shell hands userscripts
  to the native side already parsed. Forced with `adb shell setprop
  debug.once.lite.devtools off` (debuggable builds); covered by
  `tests/unit/mobile/lite-tier2.test.js`, `DnrEvaluatorTest` (JUnit),
  `LiteTier2Test` and the Lite smoke in Tier 2
  (`test:mobile:e2e:android:lite:tier2:local`). Left out: header rules,
  scriptlets, site-specific cosmetics, uBO Lite's optional rulesets,
  dashboard and strict-block page, extension pages, worker requests.
