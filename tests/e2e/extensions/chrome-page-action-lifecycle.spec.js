const { expect, test } = require("../shared/browser-evidence")
const { launchExtensionChrome } = require("../shared/extension-chrome")
const { startStoryFixture } = require("./local-source")

test("page target listeners stop quietly when the extension is reloaded", async () => {
  const source = await startStoryFixture()
  const browser = await launchExtensionChrome({ profilePrefix: "once-target-lifecycle-" }).catch(async (error) => {
    await source.close()
    throw error
  })
  const { context } = browser
  try {
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
    await browser.close(() => source.close())
  }
})
