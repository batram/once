import UIKit
import WebKit

extension HostTest {
 func testUBlockTools() async throws {
  _ = try host.command("enable", id:"addon@darkreader.org", enabled:false)
  let origin = "webkit-extension://once-ublock-origin-lite/picker-ui.html"
  let cases: [(String, Bool?, WebExtensionHost.NavigationDisposition)] = [
   (origin, false, .allow), (origin, true, .cancel), (origin, nil, .cancel),
   ("webkit-extension://unknown/picker-ui.html", false, .cancel),
   ("webkit-extension://once-ublock-origin-lite:123/picker-ui.html", false, .cancel),
   ("webkit-extension://once-darkreader/index.html", false, .cancel),
   ("about:blank", false, .allow), ("about:srcdoc", false, .allow),
   ("about:blank", true, .cancel), ("about:blank", nil, .cancel), ("about:config", false, .cancel),
   ("https://example.com", true, .allow), ("https://example.com", false, .allow),
   ("https://example.com", nil, .external), ("mailto:test@example.com", true, .external)
  ]
  results["navigationPolicyPassed"] = cases.allSatisfy { host.navigationDisposition(for:URL(string:$0.0)!,targetIsMainFrame:$0.1) == $0.2 }
  var html = "<html><head><meta name='viewport' content='width=device-width'><style>body{font:18px system-ui;margin:24px}#target{padding:40px;background:#ffd966;color:#111;margin-top:32px}</style></head><body><h1>Element tools test</h1><p>Keep this text.</p><div id='target'>Remove this element</div></body></html>"
  if CommandLine.arguments.contains("--strict-csp") {
   html = html.replacingOccurrences(of:"<head>",with:"<head><meta http-equiv='Content-Security-Policy' content=\"default-src 'self'; style-src 'unsafe-inline'; frame-src 'self'\">")
  }
  for (name, selector) in [("zapper", "#gotoZapper"), ("picker", "#gotoPicker")] {
   host.closePage()
   web.loadHTMLString(html, baseURL:URL(string:"https://example.com/once-tools"))
   await pause()
   let page = try await extensionPage("ublock-origin-lite", action:"action")
   host.closePage(requestedBy:web)
   results[name + "IgnoresPageClose"] = page.superview != nil
   _ = try? await value("setTimeout(() => document.querySelector('\(selector)').click(), 50); true", in:page)
   await pause()
   results[name + "PopupClosed"] = page.superview == nil
   results[name + "Overlay"] = try await value("[...document.querySelectorAll('iframe')].map(f=>({src:f.src,width:f.getBoundingClientRect().width,height:f.getBoundingClientRect().height,attributes:[...f.attributes].map(a=>[a.name,a.value])}))")
   guard let frame = toolFrames["/\(name)-ui.html"] else { throw NSError(domain:"Missing tool frame: \(name)",code:1) }
   results[name + "Frame"] = try await web.callAsyncJavaScript("return {width:innerWidth,height:innerHeight,loading:document.body.classList.contains('loading')}",arguments:[:],in:frame,contentWorld:.page)
   _ = try await web.callAsyncJavaScript("document.querySelector('svg#overlay').dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:120,clientY:200})); return true",arguments:[:],in:frame,contentWorld:.page)
   await pause()
   if name == "zapper" {
    // Mobile zapper taps once to highlight, then again on the highlighted island.
    _ = try await web.callAsyncJavaScript("document.querySelector('svg#overlay > path + path').dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:120,clientY:200})); return true",arguments:[:],in:frame,contentWorld:.page)
    await pause()
   } else {
    results["pickerCanCreate"] = try await web.callAsyncJavaScript("return !document.querySelector('#create').disabled",arguments:[:],in:frame,contentWorld:.page)
    _ = try await web.callAsyncJavaScript("document.querySelector('#create').click(); return true",arguments:[:],in:frame,contentWorld:.page)
    await pause()
   }
   results[name + "TargetHidden"] = try await value("!document.querySelector('#target') || getComputedStyle(document.querySelector('#target')).display === 'none'")
   web.loadHTMLString(html, baseURL:URL(string:"https://example.com/once-tools"))
   await pause()
   results[name + "HiddenAfterReload"] = try await value("!document.querySelector('#target') || getComputedStyle(document.querySelector('#target')).display === 'none'")
   save()
  }
  if CommandLine.arguments.contains("--inspect-zapper") {
   web.loadHTMLString(html, baseURL:URL(string:"https://example.org/once-tools"))
   await pause()
   let page = try await extensionPage("ublock-origin-lite", action:"action")
   _ = try? await value("document.querySelector('#gotoZapper').click()",in:page)
   await pause()
  }
 }
}
