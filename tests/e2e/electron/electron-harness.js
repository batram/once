const { expect, _electron: electron } = require("@playwright/test")
const fs = require("node:fs/promises")
const http = require("node:http")
const os = require("node:os")
const path = require("node:path")

async function startPageServer() {
  let origin
  const server = http.createServer((request, response) => {
    const name = request.url.slice(1) || "one"
    const title = name.charAt(0).toUpperCase() + name.slice(1)
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    response.end(`<!doctype html>
      <title>${title}</title>
      <h1>${title}</h1>
      <a id="page-link" href="${origin || ""}/linked">Linked page</a>
      <input id="page-input" value="editable" />`)
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  origin = `http://127.0.0.1:${server.address().port}`
  return {
    origin,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

async function launchApp() {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), "once-electron-test-"))
  const executablePath = path.resolve(__dirname, "../../../node_modules/electron/dist/electron.exe")
  const appPath = path.resolve(__dirname, "../../../apps/electron/.webpack/x64/main/index.js")
  const electronApp = await electron.launch({
    executablePath,
    args: [appPath],
    env: {
      ...process.env,
      ONCE_ELECTRON_TEST_USER_DATA: userData,
      ONCE_ELECTRON_DISABLE_STORY_LOADING: "1",
      ONCE_ELECTRON_DISABLE_NETWORK_FETCH: "1",
    },
  })
  await expect.poll(() => electronApp.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().length
  ), { timeout: 10_000 }).toBe(1)
  const window = await electronApp.firstWindow()
  await expect.poll(() => window.evaluate(() => window.onceElectron.tabs.getAll()))
    .toMatchObject([{ url: "about:blank", active: true }])
  return { electronApp, userData, window }
}

async function closeApp(electronApp, userData) {
  await electronApp.close()
  await fs.rm(userData, { recursive: true, force: true })
}

async function getWindowTabs(electronApp, windowId) {
  return electronApp.evaluate(async ({ BrowserWindow }, id) => {
    const target = BrowserWindow.fromId(id)
    if (!target) throw new Error(`Missing BrowserWindow ${id}`)
    return target.webContents.executeJavaScript("window.onceElectron.tabs.getAll()")
  }, windowId)
}

async function getOnceWindows(electronApp) {
  return electronApp.evaluate(async ({ BrowserWindow }) =>
    Promise.all(BrowserWindow.getAllWindows().map(async (candidate) => ({
      id: candidate.id,
      tabs: await candidate.webContents.executeJavaScript("window.onceElectron.tabs.getAll()"),
    })))
  )
}

async function markLiveContents(electronApp, url) {
  return electronApp.evaluate(async ({ webContents }, targetUrl) => {
    const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === targetUrl)
    if (!contents) throw new Error(`Missing webContents for ${targetUrl}`)
    await contents.executeJavaScript("window.__onceE2EState = 42")
    return contents.id
  }, url)
}

async function getLiveContentsState(electronApp, contentsId) {
  return electronApp.evaluate(async ({ webContents }, id) => {
    const contents = webContents.fromId(id)
    if (!contents || contents.isDestroyed()) return null
    return {
      url: contents.getURL(),
      state: await contents.executeJavaScript("window.__onceE2EState"),
    }
  }, contentsId)
}

async function transferTab(electronApp, windowId, action, tabId) {
  if (action !== "detach" && action !== "moveHere") {
    throw new Error(`Unsupported tab transfer: ${action}`)
  }
  return electronApp.evaluate(async ({ BrowserWindow }, request) => {
    const target = BrowserWindow.fromId(request.windowId)
    if (!target) throw new Error(`Missing BrowserWindow ${request.windowId}`)
    const script = `window.onceElectron.tabs[${JSON.stringify(request.action)}](${JSON.stringify(request.tabId)})`
    await target.webContents.executeJavaScript(script)
  }, { windowId, action, tabId })
}

module.exports = {
  closeApp,
  getLiveContentsState,
  getOnceWindows,
  getWindowTabs,
  launchApp,
  markLiveContents,
  startPageServer,
  transferTab,
}
