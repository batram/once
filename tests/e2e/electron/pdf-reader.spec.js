const http = require("node:http")
const fs = require("node:fs/promises")
const { test, expect, launchApp, closeApp } = require("./electron-harness")

for (const scanned of [false, true]) {
  test(`PDF Reader uses ${scanned ? "embedded text and scan OCR in page order" : "embedded text"}`, async () => {
    test.skip(scanned && !["darwin", "win32"].includes(process.platform), "Scan OCR needs Apple Vision or Windows.Media.Ocr")
    const { electronApp: app, userData, window } = await launchApp({ env: { ONCE_ELECTRON_DISABLE_NETWORK_FETCH: "0" } })
    let server
    try {
      const pdf = Buffer.from(await app.evaluate(async ({ BrowserWindow }, scanned) => {
        const document = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
        try {
          await document.loadURL("data:text/html," + encodeURIComponent(`<!doctype html><title>PDF Reader sample</title>
            <style>@page {margin:32px} section {break-after:page} p{font:18px Arial;line-height:1.6;max-width:600px;text-indent:2em}</style>
            <section><h1>Embedded PDF chapter</h1><p>This sentence comes from the PDF text layer. It should be readable without optical character recognition.</p>
            <p>A second paragraph stays separate for reading and speech.</p></section>${scanned ? '<section><img id="scan" style="width:600px"></section>' : ""}`))
          if (scanned) await document.webContents.executeJavaScript(`(() => {
            const canvas=document.createElement('canvas');canvas.width=1200;canvas.height=400;
            const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,1200,400);
            ctx.fillStyle='black';ctx.font='40px Arial';
            ctx.fillText('Scanned PDF chapter',50,90);
            ctx.fillText('This sentence exists only as pixels on page two.',50,190);
            ctx.fillText('Native recognition makes it available to Reader.',50,260);
            const image=document.querySelector('#scan');image.src=canvas.toDataURL('image/png');
            return image.decode();
          })()`)
          return (await document.webContents.printToPDF({ printBackground: true, pageSize: "A4" })).toString("base64")
        } finally { document.destroy() }
      }, scanned), "base64")
      server = http.createServer((_, response) => { response.writeHead(200, { "content-type": "application/pdf", "content-length": pdf.length }); response.end(pdf) })
      await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
      const url = `http://127.0.0.1:${server.address().port}/document`
      const address = window.locator("#urlfield")
      await address.fill(url); await address.press("Enter")
      await expect.poll(() => window.evaluate(async () => {
        const tab = (await window.onceElectron.tabs.getAll()).find(t => t.active)
        return tab && { url: tab.url, loading: tab.loading }
      })).toEqual({ url, loading: false })
      await window.locator("#browser_reader").click()
      await expect.poll(() => app.evaluate(async ({ webContents }) => {
        const page = webContents.getAllWebContents().find(c => c.getURL().startsWith("once-reader://"))
        return page ? page.executeJavaScript("document.querySelector('article')?.innerText || document.body.innerText") : ""
      }), { timeout: 25_000 }).toContain("This sentence comes from the PDF text layer.")
      for (const theme of ["light", "dark"]) {
        const state = await app.evaluate(async ({ webContents }, theme) => {
          const reader = webContents.getAllWebContents().find(c => c.getURL().startsWith("once-reader://"))
          return reader.executeJavaScript(`(() => {
            document.documentElement.dataset.theme=${JSON.stringify(theme)};
            const article=document.querySelector('article'),r=article.getBoundingClientRect();
            return {text:article.innerText,paragraphs:[...article.querySelectorAll('p')].map(p=>p.textContent),
              width:r.width,left:r.left,right:r.right,viewport:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,
              background:getComputedStyle(document.documentElement).backgroundColor,title:document.title};
          })()`)
        }, theme)
        expect(state.text).toContain("A second paragraph stays separate")
        expect(state.paragraphs).toContain("This sentence comes from the PDF text layer. It should be readable without optical character recognition.")
        expect(state.paragraphs).toContain("A second paragraph stays separate for reading and speech.")
        if (scanned) {
          expect(state.text).toContain("This sentence exists only as pixels on page two.")
          expect(state.text.indexOf("Embedded PDF chapter")).toBeLessThan(state.text.indexOf("Scanned PDF chapter"))
        }
        expect(state.width).toBeGreaterThan(200); expect(state.left).toBeGreaterThanOrEqual(0)
        expect(state.right).toBeLessThanOrEqual(state.viewport); expect(state.overflow).toBe(false)
        expect(state.background).toBe(theme === "dark" ? "rgb(40, 42, 54)" : "rgb(246, 246, 239)")
        const png = await app.evaluate(async ({ webContents }) => {
          const reader = webContents.getAllWebContents().find(c => c.getURL().startsWith("once-reader://"))
          reader.invalidate(); await reader.executeJavaScript("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))")
          return (await reader.capturePage()).toPNG().toString("base64")
        })
        await fs.writeFile(test.info().outputPath(`pdf-reader-${theme}.png`), Buffer.from(png,"base64"))
      }
      await expect(window.locator("#url_error")).toBeHidden()
    } finally { await closeApp(app,userData); if(server) await new Promise(resolve=>server.close(resolve)) }
  })
}
