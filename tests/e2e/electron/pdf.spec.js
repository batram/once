const { test, expect } = require("@playwright/test")
const http = require("node:http")
const path = require("node:path")
const { launchApp, closeApp } = require("./electron-harness")

const PDF_VIEWER = "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/"
const fixture = path.resolve(__dirname, "../../fixtures/extensions/pdf-content")

async function viewerState(electronApp, url) {
  return electronApp.evaluate(async ({ webContents }, { url, prefix }) => {
    const tab = webContents.getAllWebContents().find(item => item.getURL() === url)
    const viewer = tab?.mainFrame.framesInSubtree.find(frame => frame.url.startsWith(prefix))
    return viewer ? viewer.executeJavaScript(`(() => {
      const viewer = document.querySelector('pdf-viewer')
      return { state: viewer?.loadState_, pages: viewer?.documentDimensions?.pageDimensions?.length }
    })()`) : null
  }, { url, prefix: PDF_VIEWER })
}

test("extensions run on HTML but leave native PDF documents and their frames alone", async () => {
  const { electronApp, userData, window } = await launchApp({
    env: { ONCE_ELECTRON_EXTENSIONS: [fixture, process.env.ONCE_PDF_TEST_DARK_READER].filter(Boolean).join(path.delimiter) }
  })
  const server = http.createServer()
  try {
    const pdf = Buffer.from(await electronApp.evaluate(async ({ BrowserWindow }) => {
      const document = new BrowserWindow({ show: false })
      try {
        await document.loadURL("data:text/html,<h1>Once PDF regression</h1>")
        return (await document.webContents.printToPDF({})).toString("base64")
      } finally { document.destroy() }
    }), "base64")
    server.on("request", (request, response) => {
      const url = new URL(request.url, "http://localhost")
      if (url.pathname === "/document") {
        response.writeHead(200, { "content-type": "application/pdf", "content-length": pdf.length })
        response.end(pdf)
      } else {
        response.writeHead(200, { "content-type": "text/html" })
        response.end(url.pathname === "/embedded"
          ? '<!doctype html><iframe src="/document?embedded" style="width:800px;height:700px"></iframe>'
          : `<!doctype html><title>HTML control</title><p>Ordinary HTML</p>${url.pathname === "/looks-like.pdf" ? '<iframe src="/child.html"></iframe>' : ""}`)
      }
    })
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
    const origin = `http://127.0.0.1:${server.address().port}`
    const inventory = () => window.evaluate(() => window.onceElectron.extensions.list())
    await expect.poll(async () => (await inventory()).map(item => item.name))
      .toContain("PDF content boundary fixture")
    const extension = (await inventory()).find(item => item.name === "PDF content boundary fixture")
    const backgroundUrl = `moz-extension://${extension.host}/`
    const visits = () => electronApp.evaluate(async ({ webContents }, prefix) => {
      const background = webContents.getAllWebContents().find(item => item.getURL().startsWith(prefix))
      return background.executeJavaScript("globalThis.contentVisits")
    }, backgroundUrl)

    // A .pdf suffix on HTML must not prevent content scripts, including in child frames.
    const htmlUrl = `${origin}/looks-like.pdf`
    const tabId = await window.evaluate(url => window.onceElectron.tabs.create(url, true), htmlUrl)
    await expect.poll(visits).toEqual(expect.arrayContaining([
      { url: htmlUrl, contentType: "text/html" },
      { url: `${origin}/child.html`, contentType: "text/html" }
    ]))
    const contentId = await electronApp.evaluate(({ webContents }, url) =>
      webContents.getAllWebContents().find(item => item.getURL() === url).id, htmlUrl)

    // Navigate the same tab to an extensionless PDF: no stale HTML context may remain.
    const pdfUrl = `${origin}/document?token=a%2Bb%2Fc&inline=true`
    await window.evaluate(([id, url]) => window.onceElectron.tabs.navigate(id, url), [tabId, pdfUrl])
    await expect.poll(() => viewerState(electronApp, pdfUrl), { timeout: 15000 })
      .toMatchObject({ state: "success", pages: 1 })
    expect((await visits()).map(visit => visit.url).sort()).toEqual([htmlUrl, `${origin}/child.html`].sort())
    const injected = await electronApp.evaluate(async ({ webContents }, { prefix, id }) => {
      const background = webContents.getAllWebContents().find(item => item.getURL().startsWith(prefix))
      return background.executeJavaScript(`browser.tabs.executeScript(${id}, { code: 'document.contentType' })`)
    }, { prefix: backgroundUrl, id: contentId })
    expect(injected).toEqual([])

    const embeddedUrl = `${origin}/embedded`
    await window.evaluate(([id, url]) => window.onceElectron.tabs.navigate(id, url), [tabId, embeddedUrl])
    await expect.poll(() => viewerState(electronApp, embeddedUrl), { timeout: 15000 })
      .toMatchObject({ state: "success", pages: 1 })
    await expect.poll(visits).toEqual(expect.arrayContaining([{ url: embeddedUrl, contentType: "text/html" }]))
    expect((await visits()).map(visit => visit.url).sort()).toEqual([htmlUrl, `${origin}/child.html`, embeddedUrl].sort())
    if (process.env.ONCE_PDF_TEST_DARK_READER) {
      // Dark Reader itself skips .pdf-suffixed URLs, even when served as HTML.
      // Check its normal-page behavior on the HTML parent of the embedded PDF.
      await expect.poll(() => electronApp.evaluate(async ({ webContents }, url) => {
        const tab = webContents.getAllWebContents().find(item => item.getURL() === url)
        return tab.executeJavaScript("document.documentElement.getAttribute('data-darkreader-mode')")
      }, embeddedUrl), { timeout: 15000 }).toBe("dynamic")
    }

    // A new HTML document still receives extension content after leaving the PDF.
    await window.evaluate(([id, url]) => window.onceElectron.tabs.navigate(id, url), [tabId, htmlUrl])
    await expect.poll(async () => (await visits()).filter(visit => visit.url === htmlUrl).length).toBe(2)
  } finally {
    await closeApp(electronApp, userData)
    await new Promise(resolve => server.close(resolve))
  }
})
