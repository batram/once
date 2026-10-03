// Native integration fixture: compile alongside the production WebExtensionHost.
// Only API responses are mocked; all extension logic and video playback are real.
import UIKit
import WebKit
@main @MainActor
final class HostTest: UIResponder, UIApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
 var window: UIWindow?
 var host: WebExtensionHost!
 var web: WKWebView!
 var results: [String: Any] = [:]
 var errors: [String] = []
 var requests: [String] = []
 var toolFrames: [String: WKFrameInfo] = [:]
 func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
  if message.name == "toolFrame" { toolFrames[String(describing:message.body)] = message.frameInfo; return }
  let text = String(describing: message.body)
  if text.contains("mock-fetch:") { requests.append(text) } else { errors.append(text) }
 }
 func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
  let w = UIWindow(frame: UIScreen.main.bounds); w.rootViewController = UIViewController(); w.makeKeyAndVisible(); window = w
  if CommandLine.arguments.contains("--light") { w.overrideUserInterfaceStyle = .light }
  let config = WKWebExtensionController.Configuration.default()
  let wc = WKWebViewConfiguration()
  wc.userContentController.add(self, name: "diagnostic")
  wc.userContentController.addUserScript(WKUserScript(source: """
   const report = s => webkit.messageHandlers.diagnostic.postMessage(location.href + ': ' + s);
   if (location.hostname === 'once-sponsorblock') {
    const originalFetch = fetch;
    globalThis.fetch = (input, options) => {
     const url = String(input?.url || input);
     if (!url.includes('sponsor.ajay.app')) return originalFetch(input, options);
     report('mock-fetch:' + url);
     const segment = {segment:[2,8],category:'sponsor',actionType:'skip',UUID:'fixture',videoDuration:20,locked:0,votes:5};
     const body = url.includes('/skipSegments/') ? [{videoID:'dQw4w9WgXcQ',segments:[segment]}] : [segment];
     return Promise.resolve(new Response(JSON.stringify(body), {status:200,headers:{'Content-Type':'application/json'}}));
    };
   }
   addEventListener('error', e => report(e.message));
   addEventListener('unhandledrejection', e => report(e.reason?.stack || e.reason));
  """, injectionTime: .atDocumentStart, forMainFrameOnly: false))
  config.webViewConfiguration = wc
  host = WebExtensionHost(configuration: config)
  let pageConfig = WKWebViewConfiguration(); pageConfig.webExtensionController = host.controller; pageConfig.allowsInlineMediaPlayback = true; pageConfig.mediaTypesRequiringUserActionForPlayback = []
  pageConfig.userContentController.add(self, name:"toolFrame")
  pageConfig.userContentController.addUserScript(WKUserScript(source:"if (location.protocol === 'webkit-extension:') addEventListener('load', () => webkit.messageHandlers.toolFrame.postMessage(location.pathname))",injectionTime:.atDocumentStart,forMainFrameOnly:false))
  web = WKWebView(frame: w.bounds.insetBy(dx: 0, dy: 70), configuration: pageConfig)
  web.navigationDelegate = self
  web.uiDelegate = self
  w.rootViewController!.view.addSubview(web)
  host.attach(web, parent: w.rootViewController!.view)
  host.pageChanged = { [weak self] info in
   // Match the real shell: the browsing view is hidden behind extension pages.
   self?.web.isHidden = info["open"] as? Bool == true
   if info["open"] as? Bool == true { self?.host.pageCommand("bounds", bounds: w.bounds.insetBy(dx: 0, dy: 70)) }
  }
  Task { do { try await run() } catch { results["failure"] = error.localizedDescription }; results["errors"] = errors; results["requests"] = requests; results["done"] = true; save() }
  return true
 }
 func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { host.navigationChanged() }
 func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
  guard let url = action.request.url else { decisionHandler(.cancel); return }
  let disposition = host.navigationDisposition(for:url, targetIsMainFrame:action.targetFrame?.isMainFrame)
  if url.scheme == "about" || url.scheme == "webkit-extension" {
   var frames = results["internalNavigations"] as? [[String:Any]] ?? []
   frames.append(["url":url.absoluteString,"allowed":disposition == .allow,"mainFrame":action.targetFrame?.isMainFrame ?? true])
   results["internalNavigations"] = frames
  }
  decisionHandler(disposition == .allow ? .allow : .cancel)
 }
 func webViewDidClose(_ webView: WKWebView) { host.closePage(requestedBy: webView) }
 func pause() async { try? await Task.sleep(for: .seconds(3)) }
 func save() {
  let url = FileManager.default.urls(for:.documentDirectory,in:.userDomainMask)[0].appendingPathComponent("results.json")
  try? JSONSerialization.data(withJSONObject:results,options:[.prettyPrinted,.sortedKeys]).write(to:url)
 }
 func value(_ code: String, in view: WKWebView? = nil) async throws -> Any {
  try await (view ?? web).evaluateJavaScript(code) ?? NSNull()
 }
 func extensionPage(_ id: String, action: String = "options") async throws -> WKWebView {
  _ = try host.command(action, id:id, enabled:true); await pause()
  guard let page = window!.rootViewController!.view.subviews.compactMap({ $0 as? WKWebView }).last, page !== web else { throw NSError(domain:"No extension page",code:1) }
  return page
 }
 func run() async throws {
  results["os"] = UIDevice.current.systemVersion
  let videoData = try Data(contentsOf: Bundle.main.url(forResource:"extension-video",withExtension:"mp4")!)
  await host.prepare(); results["catalog"] = host.catalog(); save()
  if CommandLine.arguments.contains("--ubol-only") { try await testUBlockTools(); return }
  web.loadHTMLString("<html><head><meta name='viewport' content='width=device-width'><style>body{background:white;color:black}article{padding:24px}</style></head><body><article><h1>Extension test</h1><p>Dark Reader should theme this page using the upstream extension.</p></article></body></html>", baseURL:URL(string:"https://example.com/once-test"))
  await pause()
  results["darkPage"] = try await value("({url:location.href,styles:document.querySelectorAll('.darkreader').length,background:getComputedStyle(document.body).backgroundColor,html:document.documentElement.outerHTML.slice(0,500)})")
  var dark = try await extensionPage("addon@darkreader.org", action:"action")
  results["darkPopup"] = try await value("({text:document.body.innerText.slice(0,1600),width:document.documentElement.scrollWidth,viewport:innerWidth})",in:dark)

  // Use the upstream UI message path so its caches and content scripts update.
  _ = try await dark.callAsyncJavaScript("return await chrome.runtime.sendMessage({type:'ui-bg-change-settings',data:{enabled:false}})", arguments:[:], in:nil, contentWorld:.page)
  await pause()
  results["darkDisabled"] = try await value("({styles:document.querySelectorAll('.darkreader').length,background:getComputedStyle(document.body).backgroundColor})")
  _ = try host.command("enable", id:"addon@darkreader.org", enabled:false)
  _ = try host.command("enable", id:"addon@darkreader.org", enabled:true)
  dark = try await extensionPage("addon@darkreader.org", action:"action")
  results["darkAfterRestart"] = try await value("document.body.innerText",in:dark)
  _ = try await dark.callAsyncJavaScript("return await chrome.runtime.sendMessage({type:'ui-bg-change-settings',data:{enabled:true}})", arguments:[:], in:nil, contentWorld:.page)
  await pause()
  results["darkReenabled"] = try await value("document.querySelectorAll('.darkreader').length")
  host.closePage()
  let sponsor = try await extensionPage("sponsorBlocker@ajay.app")
  results["sponsorOptions"] = try await value("({text:document.body.innerText.slice(0,1000),width:document.documentElement.scrollWidth,viewport:innerWidth,panels:[...document.querySelectorAll('#options, #category-type, table')].map(e=>({id:e.id,width:e.clientWidth,scrollWidth:e.scrollWidth,overflowX:getComputedStyle(e).overflowX}))})",in:sponsor)
  _ = try await sponsor.callAsyncJavaScript("await chrome.storage.sync.set({skipNoticeDuration:7}); return true",arguments:[:],in:nil,contentWorld:.page)
  host.closePage()
  let reopened = try await extensionPage("sponsorBlocker@ajay.app")
  results["sponsorStoredSetting"] = try await reopened.callAsyncJavaScript("return (await chrome.storage.sync.get('skipNoticeDuration')).skipNoticeDuration",arguments:[:],in:nil,contentWorld:.page)
  host.closePage()
  web.loadHTMLString("""
   <html><head><meta name="viewport" content="width=device-width"><title>Video fixture</title></head><body>
   <div id="movie_player" class="html5-video-player"><video class="html5-main-video" autoplay muted playsinline controls src="data:video/mp4;base64,\(videoData.base64EncodedString())" style="width:360px;height:220px"></video><div class="ytp-progress-bar" style="width:360px;height:10px"></div><div class="ytp-right-controls"></div></div>
   <script>
   const v=document.querySelector('video'); window.seeks=[]; v.addEventListener('seeking',()=>window.seeks.push(v.currentTime));
   </script></body></html>
  """,baseURL:URL(string:"https://www.youtube.com/watch?v=dQw4w9WgXcQ"))
  try? await Task.sleep(for:.seconds(12))
  results["sponsorVideo"] = try await value("({url:location.href,seeks:window.seeks,duration:document.querySelector('video')?.duration,paused:document.querySelector('video')?.paused,time:document.querySelector('video')?.currentTime,markers:document.querySelectorAll('[id*=sponsor],[class*=sponsor]').length,text:document.body.innerText.slice(0,1500)})")
  try await testViolentmonkey()
  try await testUBlockTools()
 }
}
