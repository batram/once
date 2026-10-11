const fs = require("node:fs")
const http = require("node:http")
const path = require("node:path")
const { test, expect } = require("./electron-harness")
const { closeApp, launchApp } = require("./electron-harness")

// Two servers, so 127.0.0.1 shows up on a second, unusual port: an origin no
// guess of the site's usual hosts would name. The page on localhost embeds a
// frame from that port.
function startServer(handler) {
  const server = http.createServer(handler)
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port })))
}

const WRITE = (key) => `(async () => {
  localStorage.setItem(${JSON.stringify(key)}, "1")
  await new Promise((resolve, reject) => {
    const open = indexedDB.open(${JSON.stringify(`db-${key}`)})
    open.onsuccess = () => { open.result.close(); resolve() }
    open.onerror = () => reject(open.error)
  })
  return true
})()`

const READ = `(async () => ({
  local: Object.keys(localStorage).sort(),
  idb: (await indexedDB.databases()).map(db => db.name).sort()
}))()`

test("a site's data from tabs closed before a restart is still cleared, and the record with it", async () => {
  test.setTimeout(120_000)
  const odd = await startServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    response.end("<!doctype html><title>odd port</title><p>odd</p>")
  })
  const main = await startServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    response.end(`<!doctype html><title>top</title><iframe src="http://127.0.0.1:${odd.port}/frame"></iframe>`)
  })
  const oddPage = `http://127.0.0.1:${odd.port}/page`
  const top = `http://localhost:${main.port}/top`
  const launched = await launchApp()
  const { userData } = launched
  let { electronApp, window } = launched
  const recordFile = path.join(userData, "browsing-origins.json")
  const recorded = () => {
    try { return JSON.parse(fs.readFileSync(recordFile, "utf8")).sort() } catch { return null }
  }

  // Runs `code` in the tab showing `url`, or in its 127.0.0.1 frame, giving
  // up after two seconds: a frame torn down mid-call never answers.
  const run = (url, code, inFrame = false) => electronApp.evaluate(async ({ webContents }, [target, script, frame]) => {
    const tab = webContents.getAllWebContents().find((item) => item.getURL() === target)
    if (!tab) return null
    const where = frame ? tab.mainFrame.framesInSubtree.find((item) => item.url.includes("/frame")) : tab.mainFrame
    if (!where) return null
    return Promise.race([where.executeJavaScript(script), new Promise((resolve) => setTimeout(() => resolve(null), 2_000))])
  }, [url, code, inFrame])
  const open = (url) => window.evaluate((target) => window.onceElectron.tabs.create(target, true), url)
  const closeTabs = async () => {
    for (const tab of await window.evaluate(() => window.onceElectron.tabs.getAll())) {
      if (tab.url.startsWith("http")) await window.evaluate((id) => window.onceElectron.tabs.close(id), tab.id)
    }
  }

  try {
    await open(oddPage)
    await open(top)
    await expect.poll(() => run(oddPage, WRITE("odd")), { timeout: 15_000 }).toBe(true)
    await expect.poll(() => run(top, WRITE("embedded"), true), { timeout: 15_000 }).toBe(true)
    await expect.poll(() => run(top, WRITE("top")), { timeout: 15_000 }).toBe(true)
    const oddOrigin = `http://127.0.0.1:${odd.port}`
    const mainOrigin = `http://localhost:${main.port}`
    // The iframe's origin is recorded as well as the pages', and it reaches disk.
    await expect.poll(recorded, { timeout: 10_000 }).toEqual([oddOrigin, mainOrigin].sort())

    // Nothing open names the odd port any more, not even after a restart.
    await closeTabs()
    await closeApp(electronApp, userData, { keepUserData: true })
    ;({ electronApp, window } = await launchApp({ userData }))
    expect(await window.evaluate(() => window.onceElectron.tabs.getAll())).toMatchObject([{ url: "about:blank" }])

    await window.evaluate(() => window.onceElectron.browsingData.clearSite("127.0.0.1"))
    expect(recorded(), "clearing a site forgets its origins").toEqual([mainOrigin])

    // Back on both pages: the odd-port page and the embedded frame start empty,
    // and localhost's own data is still there.
    await open(oddPage)
    await open(top)
    const empty = { local: [], idb: [] }
    await expect.poll(() => run(oddPage, READ), { timeout: 15_000 }).toEqual(empty)
    await expect.poll(() => run(top, READ, true), { timeout: 15_000 }).toEqual(empty)
    await expect.poll(() => run(top, READ), { timeout: 15_000 }).toEqual({ local: ["top"], idb: ["db-top"] })

    // Clearing everything empties the record.
    await window.evaluate(() => window.onceElectron.browsingData.clearAll())
    expect(recorded()).toEqual([])
  } finally {
    await closeApp(electronApp, userData)
    odd.server.close()
    main.server.close()
  }
})
