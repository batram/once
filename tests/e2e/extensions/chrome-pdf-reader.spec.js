const { chromium } = require("@playwright/test")
const { expect, test, waitForExtensionWorker } = require("../shared/browser-evidence")
const fs = require("node:fs/promises")
const os = require("node:os")
const path = require("node:path")
const http = require("node:http")
const { textPdf, imagePdf } = require("../shared/pdf-text-fixture")

for (const scanned of [false,true]) {
  test(`Chrome extension PDF Reader ${scanned ? "reports missing OCR for a scan" : "reads embedded text"}`, async () => {
    const extensionPath = path.resolve(__dirname,"../../../apps/chrome-extension/dist/release")
    const profile = await fs.mkdtemp(path.join(os.tmpdir(),"once-pdf-extension-"))
    const pdf = scanned ? imagePdf() : textPdf()
    const server = http.createServer((_,response)=>{response.writeHead(200,{"content-type":"application/pdf","content-length":pdf.length});response.end(pdf)})
    await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve))
    const context = await chromium.launchPersistentContext(profile, {channel:"chromium",args:[`--disable-extensions-except=${extensionPath}`,`--load-extension=${extensionPath}`]})
    try {
      const worker=await waitForExtensionWorker(context)
      const id=new URL(worker.url()).host
      const panel=await context.newPage()
      await panel.goto(`chrome-extension://${id}/static/sidepanel.html?once-e2e=1`)
      await expect(panel.locator("body")).toHaveAttribute("data-once-ready","true")
      const created=context.waitForEvent("page")
      await panel.evaluate(url=>globalThis.chrome.runtime.sendMessage({onceCommand:"openReader",url,theme:"dark"}),`http://127.0.0.1:${server.address().port}/document`)
      const reader=await created
      // PDF.js parses on the sandbox frame's own thread; a cold first run outlasts the local 5 s expect budget.
      const extracted={timeout:20_000}
      if (scanned) {
        await expect(reader.locator("body")).toContainText("PDF page 1 has no embedded text",extracted)
        await expect(reader.locator("body")).toContainText("OCR is not available on this platform")
        return
      }
      await expect(reader.locator("article")).toContainText("Readable PDF text across platforms.",extracted)
      await expect(reader.locator("html")).toHaveAttribute("data-theme","dark")
      expect(new URL(reader.url()).searchParams.get("pdf")).toBe("1")
      const geometry=await reader.locator("article").evaluate(article=>({width:article.getBoundingClientRect().width,overflow:document.documentElement.scrollWidth>innerWidth}))
      expect(geometry.width).toBeGreaterThan(200);expect(geometry.overflow).toBe(false)
    } finally {await context.close();await new Promise(resolve=>server.close(resolve));await fs.rm(profile,{recursive:true,force:true})}
  })
}
