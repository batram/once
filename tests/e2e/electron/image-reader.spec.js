const fs = require("node:fs/promises")
const { test, expect, launchApp, closeApp } = require("./electron-harness")
const { startImageTextServer } = require("../shared/image-text-fixture")

test.skip(process.platform !== "darwin", "Apple Vision is a macOS platform capability")

test("Reader extracts image text through the native retrieval API", async () => {
  const server = await startImageTextServer()
  const { electronApp: app, userData, window } = await launchApp({ env: { ONCE_ELECTRON_DISABLE_NETWORK_FETCH: "0" } })
  try {
    const address = window.locator("#urlfield")
    await address.fill(`${server.origin}/`)
    await address.press("Enter")
    await expect.poll(() => app.evaluate(async ({ webContents }, url) => {
      const page = webContents.getAllWebContents().find(c => c.getURL() === url)
      return page ? page.executeJavaScript("Boolean(document.querySelector('img')?.src.startsWith('data:image/'))") : false
    }, `${server.origin}/`)).toBe(true)
    const bytes = process.env.ONCE_OCR_TEST_IMAGE
      ? await fs.readFile(process.env.ONCE_OCR_TEST_IMAGE)
      : Buffer.from(await app.evaluate(async ({ webContents }, url) => {
        const page = webContents.getAllWebContents().find(c => c.getURL() === url)
        return page.executeJavaScript("document.querySelector('img').src.split(',')[1]")
      }, `${server.origin}/`), "base64")
    server.setImage(bytes)
    await address.fill(`${server.origin}/image.png`)
    await address.press("Enter")
    await expect.poll(() => app.evaluate(({ webContents }, url) =>
      webContents.getAllWebContents().some(c => c.getURL() === url), `${server.origin}/image.png`)).toBe(true)
    await expect.poll(() => window.evaluate(async () => {
      const tab = (await window.onceElectron.tabs.getAll()).find(t => t.active)
      return tab && { url: tab.url, loading: tab.loading }
    })).toEqual({ url: `${server.origin}/image.png`, loading: false })
    await window.locator("#browser_reader").click()
    await expect.poll(() => window.evaluate(async () => (await window.onceElectron.tabs.getAll()).find(t => t.active)?.url), { timeout: 25_000 })
      .toMatch(/^once-reader:\/\//)
    await expect.poll(() => app.evaluate(({ webContents }) => webContents.getAllWebContents().some(c => c.getURL().startsWith("once-reader://"))))
      .toBe(true)
    for (const theme of ["light", "dark"]) {
      const result = await app.evaluate(async ({ webContents }, theme) => {
        const reader = webContents.getAllWebContents().find(c => c.getURL().startsWith("once-reader://"))
        return reader.executeJavaScript(`(() => {
          document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)});
          const article = document.querySelector('article');
          const r = article.getBoundingClientRect();
          return {text:article.innerText, paragraphs:[...article.querySelectorAll("p")].map(p => p.textContent), width:r.width, left:r.left, right:r.right,
            viewport:innerWidth, overflow:document.documentElement.scrollWidth > innerWidth,
            background:getComputedStyle(document.documentElement).backgroundColor};
        })()`)
      }, theme)
      expect(result.text).toContain(process.env.ONCE_OCR_EXPECT_TEXT || (process.env.ONCE_OCR_TEST_IMAGE ? "Ogilvy" : "Native Apple Vision"))
      if (process.env.ONCE_OCR_EXPECT_TEXT === "Communication Within Tesla") {
        expect(result.paragraphs[0]).toBe("Subject: Communication Within Tesla")
        expect(result.paragraphs[1]).toContain("By far the most common way")
        expect(result.paragraphs[1]).toContain("it fails to serve the company.")
        expect(result.paragraphs[2]).toContain("No kidding.")
      }
      expect(result.background).toBe(theme === "dark" ? "rgb(40, 42, 54)" : "rgb(246, 246, 239)")
      expect(result.width).toBeGreaterThan(200)
      expect(result.left).toBeGreaterThanOrEqual(0)
      expect(result.right).toBeLessThanOrEqual(result.viewport)
      expect(result.overflow).toBe(false)
      const png = await app.evaluate(async ({ webContents }) => {
        const reader = webContents.getAllWebContents().find(c => c.getURL().startsWith("once-reader://"))
        reader.invalidate()
        await reader.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
        return (await reader.capturePage()).toPNG().toString("base64")
      })
      await fs.writeFile(test.info().outputPath(`image-reader-${theme}.png`), Buffer.from(png, "base64"))
    }
    await expect(window.locator("#url_error")).toBeHidden()
  } finally {
    await closeApp(app, userData)
    await server.close()
  }
})
