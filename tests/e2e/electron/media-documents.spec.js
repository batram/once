const { test, expect, launchApp, closeApp } = require("./electron-harness")
const fs = require("node:fs")
const http = require("node:http")
const path = require("node:path")

const video = fs.readFileSync(path.resolve(__dirname, "../mobile/fixtures/extension-video.mp4"))

// Chromium's media document never finishes loading, so loadURL rejects with
// ERR_FAILED while the player is up; the tab must keep it, not an error page.
test("a video opened on its own plays in the tab instead of an error page", async () => {
  const { electronApp, userData, window } = await launchApp()
  const server = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "video/mp4", "content-length": video.length, "accept-ranges": "bytes" })
    response.end(video)
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const url = `http://127.0.0.1:${server.address().port}/clip.mp4`
  try {
    await window.evaluate(target => window.onceElectron.tabs.create(target, true), url)
    const player = () => electronApp.evaluate(({ webContents }, target) => {
      const tab = webContents.getAllWebContents().find(contents => contents.getURL() === target)
      return tab?.executeJavaScript("Boolean(document.querySelector('video'))") ?? false
    }, url)
    await expect.poll(player).toBe(true)
    // Long enough for the rejected load to have turned into an error page.
    await window.waitForTimeout(1_000)
    const tab = (await window.evaluate(() => window.onceElectron.tabs.getAll())).find(item => item.url === url)
    expect(tab).toEqual(expect.objectContaining({ loadError: null }))
    expect(await player()).toBe(true)
  } finally {
    server.close()
    await closeApp(electronApp, userData)
  }
})
