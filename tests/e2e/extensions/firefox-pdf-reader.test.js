const test = require("node:test")
const assert = require("node:assert/strict")
const http = require("node:http")
const path = require("node:path")
const { Builder, By } = require("selenium-webdriver")
const firefox = require("selenium-webdriver/firefox")
const { textPdf, imagePdf } = require("../shared/pdf-text-fixture")
const { openExtensionPanel, systemAccessService, budget, logBrowserVersion } = require("./firefox-panel")

// Firefox's own PDF viewer is privileged, so a PDF source moves to the
// extension's reader page, which extracts the text in the packaged PDF sandbox
// (an opaque-origin frame where Gecko, unlike Chromium, may still run a worker).
test("Firefox reads a PDF source in its own reader page through the PDF sandbox", { timeout: budget(120_000) }, async () => {
  const expectedAddonId = "once_sidepanel_f@zmarn.com"
  const extensionUuid = "00000000-0000-4000-8000-000000000003"
  // `/paper.pdf` is labelled as a generic download, as many servers do; only its name says PDF.
  const documents = { "/document": textPdf(), "/scan": imagePdf(), "/paper.pdf": textPdf() }
  const requests = []
  const server = http.createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`)
    const pdf = documents[request.url]
    if (!pdf) { response.writeHead(404); response.end(); return }
    const type = request.url === "/paper.pdf" ? "application/octet-stream" : "application/pdf"
    response.writeHead(200, { "content-type": type, "content-length": pdf.length })
    response.end(pdf)
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const options = new firefox.Options()
    .addArguments("-no-remote")
    .setPreference("extensions.webextensions.uuids", JSON.stringify({ [expectedAddonId]: extensionUuid }))
    .enableBidi()
  if (process.platform !== "win32") options.addArguments("-headless")
  const driver = await new Builder().forBrowser("firefox").setFirefoxOptions(options).setFirefoxService(systemAccessService()).build()
  await logBrowserVersion(driver)
  try {
    const bidi = await driver.getBidi()
    const installResult = await bidi.send({
      method: "webExtension.install",
      params: { extensionData: { type: "path", path: path.resolve(__dirname, "../../../apps/firefox-extension/dist/release") } }
    })
    assert.equal(installResult.result.extension, expectedAddonId)
    const panel = await openExtensionPanel(driver, extensionUuid)

    const readerText = async (url, expectation) => {
      const before = await driver.getAllWindowHandles()
      await driver.executeAsyncScript("browser.runtime.sendMessage({ onceCommand: 'openReader', url: arguments[0], theme: 'dark' }).then(arguments[1], arguments[1])", url)
      const handle = await driver.wait(async () => (await driver.getAllWindowHandles()).find(h => !before.includes(h)) || false, budget(10_000), "reader tab did not open")
      await driver.switchTo().window(handle)
      await driver.wait(async () => {
        try { return (await driver.findElement(By.css("body")).getText()).includes(expectation) } catch { return false }
      }, budget(30_000), `reader did not show: ${expectation}`)
      const url2 = new URL(await driver.getCurrentUrl())
      assert.equal(url2.pathname, "/static/reader.html")
      assert.equal(url2.searchParams.get("pdf"), "1")
      assert.equal(url2.searchParams.get("sourceUrl"), url)
      const text = await driver.findElement(By.css("body")).getText()
      await driver.close()
      await driver.switchTo().window(panel)
      return text
    }
    const text = await readerText(`${origin}/document`, "Readable PDF text across platforms.")
    assert.ok(text.includes("Readable PDF text across platforms."))
    // The navigation itself is the probe: no HEAD request precedes the user's GET.
    assert.equal(requests.some(line => line.startsWith("HEAD")), false, requests.join(", "))
    const scan = await readerText(`${origin}/scan`, "PDF page 1 has no embedded text")
    assert.ok(scan.includes("OCR is not available on this platform"))
    const download = await readerText(`${origin}/paper.pdf`, "Readable PDF text across platforms.")
    assert.ok(download.includes("Readable PDF text across platforms."))
    // Reading the generic-type source must not leave a download of it behind.
    // Firefox (157) starts none at all, the source tab being closed first; the
    // list is checked anyway, since Chrome does start one (see the Chrome spec).
    await driver.wait(async () => (await driver.executeAsyncScript("browser.downloads.search({}).then(items => arguments[0](items.length), () => arguments[0](-1))")) === 0, budget(10_000), "the source's download remained")
  } finally {
    await driver.quit()
    await new Promise(resolve => server.close(resolve))
  }
})
