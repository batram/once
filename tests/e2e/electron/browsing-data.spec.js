const http = require("node:http")
const { test, expect } = require("./electron-harness")
const { closeApp, launchApp, openSettingsSection } = require("./electron-harness")

// Two sites from one local server: localhost and 127.0.0.1 are different
// sites to the browser, and each is its own site to siteForUrl.
const PAGE = "<!doctype html><title>Browsing data fixture</title><p>fixture</p>"

function startServer() {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    response.end(PAGE)
  })
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port })))
}

// What a page leaves behind: a cookie, localStorage and an IndexedDB database.
const STORE = `(async () => {
  document.cookie = "fixture=1; max-age=3600; path=/"
  localStorage.setItem("fixture", "1")
  await new Promise((resolve, reject) => {
    const open = indexedDB.open("fixture-db")
    open.onsuccess = () => { open.result.close(); resolve() }
    open.onerror = () => reject(open.error)
  })
  return true
})()`

const READ = `(async () => ({
  cookie: document.cookie.includes("fixture=1"),
  local: localStorage.getItem("fixture") === "1",
  idb: (await indexedDB.databases()).some(db => db.name === "fixture-db")
}))()`

test("clearing one site leaves the others, clearing all leaves Once's own data", async () => {
  const { server, port } = await startServer()
  const { electronApp, userData, window } = await launchApp()
  const pages = [`http://localhost:${port}/a`, `http://127.0.0.1:${port}/b`]
  try {
    // The shell's own storage lives in the default session and must survive.
    await window.evaluate(() => localStorage.setItem("once-browsing-data-e2e", "kept"))
    const shellDatabases = () => window.evaluate(async () => (await indexedDB.databases()).map(db => db.name).sort())
    const databasesBefore = await shellDatabases()
    expect(databasesBefore.length).toBeGreaterThan(0)

    for (const url of pages) await window.evaluate((target) => window.onceElectron.tabs.create(target, true), url)
    const inTab = (url, script) => electronApp.evaluate(async ({ webContents }, [target, code]) => {
      const tab = webContents.getAllWebContents().find((item) => item.getURL() === target)
      if (!tab) return null
      // Reload so the page reads what is stored, not what it still holds in memory.
      if (code === "reload") { await tab.reloadIgnoringCache(); return true }
      return tab.executeJavaScript(code)
    }, [url, script])
    for (const url of pages) await expect.poll(() => inTab(url, STORE), { timeout: 15_000 }).toBe(true)
    const stored = { cookie: true, local: true, idb: true }
    const empty = { cookie: false, local: false, idb: false }
    const expectStorage = async (url, expected) => {
      await inTab(url, "reload")
      await expect.poll(() => inTab(url, READ), { timeout: 10_000 }).toEqual(expected)
    }
    for (const url of pages) await expectStorage(url, stored)

    await window.evaluate(() => window.onceElectron.browsingData.clearSite("127.0.0.1"))
    await expectStorage(pages[1], empty)
    await expectStorage(pages[0], stored)
    await expect(window.evaluate(() => window.onceElectron.browsingData.clearSite("sub.example.com")))
      .rejects.toThrow(/Invalid site/)

    // Clear everything from Settings, through its confirmation.
    await openSettingsSection(window, "browsing-data", "#clear_browsing_data")
    await window.locator("#clear_browsing_data").click()
    await window.getByTestId("confirm-accept").click()
    await expect(window.locator("#browsing_data_status")).toHaveText(/Browsing data cleared/)
    await expectStorage(pages[0], empty)

    expect(await window.evaluate(() => localStorage.getItem("once-browsing-data-e2e"))).toBe("kept")
    expect(await shellDatabases()).toEqual(databasesBefore)
  } finally {
    await closeApp(electronApp, userData)
    server.close()
  }
})
