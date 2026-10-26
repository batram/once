// Compatibility probe: installs third-party XPIs (Host.app/compat/*.xpi) into the
// production WebExtensionHost on a simulator and records how each one fares.
// Compiled and driven by run-ios-extension-compat.js; results land in Documents/results.json.
import UIKit
import WebKit

/// One extension's findings; a class so a timed-out step keeps what it gathered.
@MainActor final class Record {
 var fields: [String: Any]
 init(_ fields: [String: Any]) { self.fields = fields }
 subscript(key: String) -> Any? { get { fields[key] } set { fields[key] = newValue } }
}

/// Resumes a continuation once, whichever of two tasks finishes first.
@MainActor final class Settle<T> {
 var continuation: CheckedContinuation<T?, Never>?
 init(_ continuation: CheckedContinuation<T?, Never>) { self.continuation = continuation }
 func resume(_ value: T?) { continuation?.resume(returning: value); continuation = nil }
}

/// nil when `work` did not finish within `seconds`; the work itself keeps running.
@MainActor func race<T>(_ seconds: Double, _ work: @escaping @MainActor () async throws -> T) async -> Result<T, Error>? {
 await withCheckedContinuation { (continuation: CheckedContinuation<Result<T, Error>?, Never>) in
  let settle = Settle<Result<T, Error>>(continuation)
  Task { @MainActor in do { settle.resume(.success(try await work())) } catch { settle.resume(.failure(error)) } }
  Task { @MainActor in try? await Task.sleep(for: .seconds(seconds)); settle.resume(nil) }
 }
}

@main @MainActor
final class CompatTest: UIResponder, UIApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
 var window: UIWindow?
 var host: WebExtensionHost!
 var web: WKWebView!
 var results: [String: Any] = ["partial": true]
 var records: [Record] = []
 var diagnostics: [(href: String, text: String)] = []
 var pagesOpened = 0
 let fixtureURL = URL(string: "https://example.com/compat")!
 static let fixtureHTML = """
  <html><head><meta name="viewport" content="width=device-width"><title>Compat fixture</title></head><body>
  <h1>Compatibility fixture</h1><p>A paragraph of text for content scripts to find, with a <a href="https://example.com/other?utm_source=test">link</a>.</p>
  <img alt="image" width="40" height="40" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"></body></html>
  """
 // Attributes extension-page and page JS errors by location.href; content-script worlds are out of reach.
 static let diagnosticScript = """
  (() => {
   const post = (kind, text) => { try { webkit.messageHandlers.diagnostic.postMessage({href: location.href, text: kind + ': ' + String(text).slice(0, 400)}) } catch {} };
   addEventListener('error', e => post('error', (e.message || e.type) + (e.filename ? ' @' + e.filename + ':' + e.lineno : '')));
   addEventListener('unhandledrejection', e => post('unhandledrejection', e.reason?.stack || e.reason));
   const original = console.error;
   console.error = (...args) => { post('console.error', args.map(a => a?.stack || a?.message || a).join(' ')); return original.apply(console, args) };
  })();
  """

 func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
  let body = message.body as? [String: Any]
  diagnostics.append((href: body?["href"] as? String ?? "", text: body?["text"] as? String ?? String(describing: message.body)))
  if diagnostics.count > 500 { diagnostics.removeFirst(100) }
 }

 func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
  let w = UIWindow(frame: UIScreen.main.bounds); w.rootViewController = UIViewController(); w.makeKeyAndVisible(); window = w
  let bounds = w.bounds.insetBy(dx: 0, dy: 70)
  let script = WKUserScript(source: Self.diagnosticScript, injectionTime: .atDocumentStart, forMainFrameOnly: false)
  // Fresh controller identity and package store: nothing leaks between runs.
  let config = WKWebExtensionController.Configuration(identifier: UUID())
  let wc = WKWebViewConfiguration()
  wc.userContentController.add(self, name: "diagnostic")
  wc.userContentController.addUserScript(script)
  config.webViewConfiguration = wc
  let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
  host = WebExtensionHost(configuration: config, store: ExtensionPackageStore(root: caches.appendingPathComponent("compat-\(UUID().uuidString)", isDirectory: true)))
  let pageConfig = WKWebViewConfiguration(); pageConfig.webExtensionController = host.controller
  pageConfig.userContentController.add(self, name: "diagnostic")
  pageConfig.userContentController.addUserScript(script)
  web = WKWebView(frame: bounds, configuration: pageConfig)
  web.navigationDelegate = self
  web.uiDelegate = self
  w.rootViewController!.view.addSubview(web)
  host.attach(web, parent: w.rootViewController!.view)
  host.select(web) // Actions and popups land on the selected tab only.
  host.pageChanged = { [weak self] info in
   let open = info["open"] as? Bool == true
   self?.web.isHidden = open
   if open { self?.pagesOpened += 1; self?.host.pageCommand("bounds", bounds: bounds) }
  }
  Task { await run(); results["done"] = true; results["partial"] = false; save() }
  return true
 }

 func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { host.navigationChanged(webView) }
 func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
  guard let url = action.request.url else { decisionHandler(.cancel); return }
  decisionHandler(host.navigationDisposition(for: url, targetIsMainFrame: action.targetFrame?.isMainFrame) == .allow ? .allow : .cancel)
 }
 func webViewDidClose(_ webView: WKWebView) { host.closePage(requestedBy: webView) }

 func save() {
  results["extensions"] = records.map(\.fields)
  let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("results.json")
  try? JSONSerialization.data(withJSONObject: results, options: [.prettyPrinted, .sortedKeys]).write(to: url)
 }

 func value(_ code: String, in view: WKWebView) async -> Any? {
  do { return try await view.evaluateJavaScript(code) } catch { return nil }
 }

 /// Diagnostics whose page URL matches, removed from the queue.
 func drain(_ matches: (String) -> Bool) -> [String] {
  let picked = diagnostics.filter { matches($0.href) }
  diagnostics.removeAll { matches($0.href) }
  return Array(picked.prefix(12).map(\.text))
 }

 func loadIndex() -> [[String: Any]] {
  let url = Bundle.main.bundleURL.appendingPathComponent("compat/index.json")
  guard let data = try? Data(contentsOf: url), let all = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]] else {
   results["failure"] = "compat/index.json is missing or invalid"; return []
  }
  let arguments = CommandLine.arguments
  guard let index = arguments.firstIndex(of: "--only"), index + 1 < arguments.count else { return all }
  let only = Set(arguments[index + 1].split(separator: ",").map(String.init))
  return all.filter { only.contains($0["slug"] as? String ?? "") }
 }

 /// Loads the fixture page and returns its serialized length after content scripts had 3 s.
 func fixtureLength() async -> Int {
  web.loadHTMLString(Self.fixtureHTML, baseURL: fixtureURL)
  try? await Task.sleep(for: .seconds(3))
  return await value("document.documentElement.outerHTML.length", in: web) as? Int ?? -1
 }

 func run() async {
  let started = Date()
  results["os"] = UIDevice.current.systemVersion
  await host.prepare()
  results["catalog"] = host.catalog()
  results["bundleFailures"] = host.failures
  // Only the extension under test should touch the fixture page.
  for bundle in WebExtensionHost.bundles { _ = try? host.command("enable", id: bundle.id, enabled: false) }
  results["baselineHtmlLength"] = await fixtureLength()
  save()
  for entry in loadIndex() {
   let record = Record(entry)
   records.append(record)
   let begun = Date()
   if await race(60, { await self.exercise(record) }) == nil { record["timeout"] = true }
   if let id = record["id"] as? String, let installed = host.installed.first(where: { $0.id == id }) {
    switch await race(15, { try await self.host.remove(installed) }) {
    case .failure(let error): record["removeError"] = error.localizedDescription
    case nil: record["removeError"] = "timeout"
    default: break
    }
   }
   host.closePage()
   record["ms"] = Int(Date().timeIntervalSince(begun) * 1000)
   save()
  }
  results["elapsedMs"] = Int(Date().timeIntervalSince(started) * 1000)
 }

 func exercise(_ record: Record) async {
  guard let file = record["file"] as? String else { record["reviewError"] = "index entry names no file"; return }
  let xpi = Bundle.main.bundleURL.appendingPathComponent("compat/\(file)")
  let candidate: ExtensionCandidate
  // The listing's guid travels with the cached file, as it does for an install from the add-on's page.
  do { candidate = try await host.review(.file(xpi), listedId: record["guid"] as? String) } catch { record["reviewError"] = error.localizedDescription; return }
  let ext = candidate.webExtension
  record["id"] = candidate.id; record["name"] = candidate.name; record["version"] = candidate.version
  record["manifestVersion"] = Int(ext.manifestVersion)
  record["permissions"] = candidate.permissions; record["adaptations"] = candidate.adaptations; record["warnings"] = candidate.warnings
  record["hasBackground"] = ext.hasBackgroundContent
  record["manifestErrors"] = ext.errors.map(\.localizedDescription)
  do { try await host.install(candidate) } catch {
   record["installError"] = error.localizedDescription; await host.store.remove(candidate.token); return
  }
  guard let context = host.context(for: candidate.id) else { record["installError"] = "No context after install"; return }
  record["loaded"] = context.isLoaded
  record["contextErrors"] = context.errors.map(\.localizedDescription)
  let origin = "://\(context.baseURL.host ?? "-")/"
  diagnostics.removeAll(); pagesOpened = 0
  if ext.hasBackgroundContent {
   switch await race(20, { try await context.loadBackgroundContent() }) {
   case .success: record["background"] = "loaded"
   case .failure(let error): record["background"] = "failed: \(error.localizedDescription)"
   case nil: record["background"] = "timeout"
   }
   try? await Task.sleep(for: .seconds(2))
   record["backgroundErrors"] = drain { $0.contains(origin) }
  } else { record["background"] = "none" }
  diagnostics.removeAll()
  let length = await fixtureLength()
  let baseline = results["baselineHtmlLength"] as? Int ?? 0
  record["injects"] = context.hasInjectedContent(for: fixtureURL)
  record["htmlLength"] = length
  record["pageMutated"] = baseline > 0 && length > 0 && abs(length - baseline) * 10 > baseline
  record["contentErrors"] = drain { $0.hasPrefix("https://example.com") }
  record["contextErrorsAfter"] = context.errors.map(\.localizedDescription)
  let row = host.catalog().first { $0["id"] as? String == candidate.id }
  let action = (ext.manifest["action"] ?? ext.manifest["browser_action"]) as? [String: Any]
  record["actionPopup"] = action?["default_popup"] != nil
  if row?["hasAction"] as? Bool == true, action?["default_popup"] != nil { record["popup"] = await page("action", id: candidate.id, origin: origin) }
  else if context.optionsPageURL != nil { record["options"] = await page("options", id: candidate.id, origin: origin) }
  else if row?["hasAction"] as? Bool == true { record["popup"] = await page("action", id: candidate.id, origin: origin) }
  record["pagesOpened"] = pagesOpened
 }

 /// Opens the popup or options page and measures what rendered; the newest web view that is not the browser.
 func page(_ action: String, id: String, origin: String) async -> [String: Any] {
  host.closePage()
  let parent = window!.rootViewController!.view!
  let before = Set(parent.subviews.compactMap { $0 as? WKWebView }.map(ObjectIdentifier.init))
  diagnostics.removeAll()
  var info: [String: Any] = ["kind": action, "opened": false]
  do {
   let reply = try host.command(action, id: id, enabled: true)
   if reply["noPage"] as? Bool == true { info["noPage"] = true }
  } catch { info["commandError"] = error.localizedDescription }
  try? await Task.sleep(for: .seconds(3))
  if let view = parent.subviews.compactMap({ $0 as? WKWebView }).last(where: { $0 !== web && !before.contains(ObjectIdentifier($0)) }) {
   info["opened"] = true
   info["url"] = view.url?.absoluteString ?? ""
   info["textLength"] = await value("document.body ? document.body.innerText.length : -1", in: view) as? Int ?? -1
   info["size"] = [Int(view.frame.width), Int(view.frame.height)]
  }
  info["errors"] = drain { $0.contains(origin) }
  host.closePage()
  return info
 }
}
