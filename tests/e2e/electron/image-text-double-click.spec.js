const { test, expect, launchApp, closeApp, warmUpTextRecognition } = require("./electron-harness")
const { startImageTextServer } = require("../shared/image-text-fixture")

test.skip(!["darwin", "win32"].includes(process.platform), "Native OCR uses Apple Vision (macOS) or Windows.Media.Ocr (Windows)")
let server
test.beforeAll(async () => {
  test.setTimeout(150_000)
  await warmUpTextRecognition()
  server = await startImageTextServer()
})
test.afterAll(async () => { await server?.close() })

const READY = `Drag to select text · ${process.platform === "darwin" ? "⌘C" : "Ctrl+C"} to copy`

async function inPage(app, script) {
  return app.evaluate(({ webContents }, { url, script }) => {
    const page = webContents.getAllWebContents().find(c => c.getURL() === url)
    if (!page) throw new Error("Missing image fixture")
    return page.executeJavaScript(script)
  }, { url: `${server.origin}/`, script })
}

async function barText(app) {
  return app.evaluate(async ({ webContents }, url) => {
    const tab = webContents.getAllWebContents().find(c => c.getURL() === url)
    return tab ? (await globalThis.__onceImageTextState(tab))?.bar?.text ?? null : null
  }, `${server.origin}/`)
}

/** A real double click, as the user's mouse gives it: through the DevTools protocol, so the page sees trusted events. */
async function doubleClick(app, x, y) {
  await app.evaluate(async ({ webContents }, { url, x, y }) => {
    const tab = webContents.getAllWebContents().find(c => c.getURL() === url)
    if (!tab.debugger.isAttached()) tab.debugger.attach("1.3")
    for (const clickCount of [1, 2]) {
      for (const type of ["mousePressed", "mouseReleased"]) {
        await tab.debugger.sendCommand("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount })
      }
    }
  }, { url: `${server.origin}/`, x: Math.round(x), y: Math.round(y) })
}

test("double-clicking an image selects its text; a page's own dblclick does not", async () => {
  const { electronApp: app, userData, window } = await launchApp()
  try {
    await window.locator("#urlfield").fill(`${server.origin}/`)
    await window.locator("#urlfield").press("Enter")
    await expect(window.locator(".electron-tab-title")).toHaveText("Image text selection fixture")
    await expect.poll(() => inPage(app, "document.querySelector('img').naturalWidth")).toBeGreaterThan(0)
    // The fixture's image is a link, whose first click would navigate away.
    await inPage(app, "(() => { const link = document.querySelector('img').closest('a'); link.replaceWith(...link.childNodes) })()")
    const center = await inPage(app, "(() => { const r = document.querySelector('img').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()")

    // Script cannot start it: only trusted input counts.
    await inPage(app, "document.querySelector('img').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 10, clientY: 10 }))")
    await new Promise(resolve => setTimeout(resolve, 500))
    expect(await barText(app)).toBeNull()

    await doubleClick(app, center.x, center.y)
    await expect.poll(() => barText(app), { timeout: 30_000 }).toContain(READY)
  } finally { await closeApp(app, userData) }
})
