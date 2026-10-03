import UIKit
import WebKit

// Uses the upstream install/export command paths and a harmless DOM/storage script.
extension HostTest {
 func testViolentmonkey() async throws {
  _ = try host.command("enable", id:"addon@darkreader.org", enabled:false)
  let page = try await extensionPage("{aecec67f-0d10-4fa7-b7c7-609a2db280cf}")
  results["vmOptions"] = try await value("({text:document.body.innerText.slice(0,500),width:document.documentElement.scrollWidth,viewport:innerWidth})",in:page)
  let script = """
  // ==UserScript==
  // @name Once VM compatibility fixture
  // @namespace once-tests
  // @match https://example.com/*
  // @run-at document-end
  // @grant GM_getValue
  // @grant GM_setValue
  // @grant GM_addStyle
  // ==/UserScript==
  const count = GM_getValue('count', 0) + 1;
  GM_setValue('count', count);
  GM_addStyle('body { color: rgb(12, 34, 56); }');
  document.body.dataset.vmCount = String(count);
  document.body.append(' Violentmonkey ran');
  document.addEventListener('once-write', () => { GM_setValue('afterWake', 42); document.body.dataset.vmWake = 'sent'; });
  """
  results["vmInstall"] = try await page.callAsyncJavaScript("return await browser.runtime.sendMessage({cmd:'ParseScript',data:{code:code}})", arguments:["code":script],in:nil,contentWorld:.page)
  let contentScript = """
  // ==UserScript==
  // @name Once VM content fixture
  // @namespace once-tests
  // @match https://example.com/*
  // @inject-into content
  // @run-at document-end
  // @grant GM_setValue
  // ==/UserScript==
  document.body.dataset.vmContentRuns = String(Number(document.body.dataset.vmContentRuns || 0) + 1);
  document.addEventListener('once-write', () => GM_setValue('afterWake', 43));
  """
  _ = try await page.callAsyncJavaScript("return await browser.runtime.sendMessage({cmd:'ParseScript',data:{code:code}})",arguments:["code":contentScript],in:nil,contentWorld:.page)
  host.closePage()
  web.loadHTMLString("<html><head><meta name='viewport' content='width=device-width'></head><body>Fixture</body></html>",baseURL:URL(string:"https://example.com/once-vm"))
  await pause()
  results["vmScriptRun"] = try await value("({text:document.body.innerText,count:document.body.dataset.vmCount,color:getComputedStyle(document.body).color})")
  let reopened = try await extensionPage("{aecec67f-0d10-4fa7-b7c7-609a2db280cf}")
  _ = try await reopened.callAsyncJavaScript("(await browser.runtime.getBackgroundPage()).location.reload(); return true", arguments:[:],in:nil,contentWorld:.page)
  await pause()
  _ = try await value("document.dispatchEvent(new Event('once-write'))")
  await pause()
  results["vmContentRunsAfterWake"] = try await value("document.body.dataset.vmContentRuns || null")
  results["vmExport"] = try await reopened.callAsyncJavaScript("return await browser.runtime.sendMessage({cmd:'ExportZip',data:{values:true}})",arguments:[:],in:nil,contentWorld:.page)
  host.closePage()
  _ = try host.command("enable",id:"{aecec67f-0d10-4fa7-b7c7-609a2db280cf}",enabled:false)
  _ = try host.command("enable",id:"{aecec67f-0d10-4fa7-b7c7-609a2db280cf}",enabled:true)
  web.loadHTMLString("<html><body>Restart fixture</body></html>",baseURL:URL(string:"https://example.com/once-vm"))
  await pause()
  results["vmAfterRestart"] = try await value("({text:document.body.innerText,count:document.body.dataset.vmCount})")
  web.loadHTMLString("<html><body>Unmatched page</body></html>",baseURL:URL(string:"https://example.org/once-vm"))
  await pause()
  results["vmUnmatched"] = try await value("document.body.dataset.vmCount || null")

 }
}
