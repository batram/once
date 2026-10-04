const { test, expect, chromium } = require("@playwright/test")
const fs = require("node:fs/promises")
const os = require("node:os")
const path = require("node:path")
const { startStoryFixture } = require("./local-source")

test("page target listeners stop quietly when the extension is reloaded", async () => {
  const extensionPath = path.resolve(__dirname, "../../../apps/chrome-extension/dist/release")
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "once-target-lifecycle-"))
  const source = await startStoryFixture()
  let context
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: "chromium",
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
    })
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker")
    await worker.evaluate(() => {
      globalThis.targetReports = 0
      globalThis.chrome.runtime.onMessage.addListener(message => { if (message.onceCommand === "page-actions-target") globalThis.targetReports++ })
    })
    const page = await context.newPage()
    const errors = []
    page.on("pageerror", error => errors.push(error.message))
    await page.goto(`${source.origin}/story/alpha`)
    const report = () => page.evaluate(() => document.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })))
    await expect.poll(async () => { await report(); return worker.evaluate(() => globalThis.targetReports) }).toBeGreaterThan(0)
    const stopped = worker.waitForEvent("close")
    await worker.evaluate(() => { setTimeout(() => globalThis.chrome.runtime.reload(), 0) })
    await stopped
    await report()
    await page.mouse.move(20, 20)
    await report()
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    expect(errors).toEqual([])
  } finally {
    await context?.close()
    await source.close()
    await fs.rm(profile, { recursive: true, force: true })
  }
})
