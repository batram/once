const http = require("node:http")
const { test, expect } = require("./electron-harness")
const { closeApp, launchApp } = require("./electron-harness")

// localhost and 127.0.0.1 are two sites. A page on localhost embeds a frame
// from 127.0.0.1, so whatever that frame stores is third-party storage,
// which Chromium partitions under localhost.
function startServer() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://x")
    const port = server.address().port
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    if (url.pathname === "/top") {
      response.end(`<!doctype html><title>top</title><iframe src="http://127.0.0.1:${port}/frame"></iframe>`)
    } else {
      response.end("<!doctype html><title>page</title><p>page</p>")
    }
  })
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

test("clearing a site reaches its third-party storage in other sites and other sites' inside it", async () => {
  test.setTimeout(60_000)
  const { server, port } = await startServer()
  const { electronApp, userData, window } = await launchApp()
  const top = `http://localhost:${port}/top`
  const first = `http://127.0.0.1:${port}/first`
  const embedded = { local: ["embedded"], idb: ["db-embedded"] }
  const firstParty = { local: ["first"], idb: ["db-first"] }
  const empty = { local: [], idb: [] }
  try {
    // Runs `code` in the top-level tab showing `url`, or in its 127.0.0.1 frame.
    // "reload" reloads the page and settles once it has loaded. A frame torn
    // down mid-call never answers, so every call gives up after two seconds.
    const run = (url, code, inFrame = false) => electronApp.evaluate(async ({ webContents }, [target, script, frame]) => {
      const tab = webContents.getAllWebContents().find((item) => item.getURL() === target)
      if (!tab) return null
      if (script === "reload") { await tab.loadURL(target); return true }
      const where = frame ? tab.mainFrame.framesInSubtree.find((item) => item.url.includes("/frame")) : tab.mainFrame
      if (!where) return null
      return Promise.race([where.executeJavaScript(script), new Promise((resolve) => setTimeout(() => resolve(null), 2_000))])
    }, [url, code, inFrame])
    const store = async () => {
      await expect.poll(() => run(top, WRITE("embedded"), true), { timeout: 15_000 }).toBe(true)
      await expect.poll(() => run(first, WRITE("first")), { timeout: 15_000 }).toBe(true)
    }
    // Reloaded first, so each reads what is stored rather than what it holds.
    const expectStored = async (expected) => {
      for (const url of [top, first]) await run(url, "reload")
      let seen
      for (const deadline = Date.now() + 10_000; Date.now() < deadline;) {
        seen = { embedded: await run(top, READ, true), firstParty: await run(first, READ) }
        if (JSON.stringify(seen) === JSON.stringify(expected)) return
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      expect(seen, "storage after reloading both pages").toEqual(expected)
    }

    for (const url of [top, first]) await window.evaluate((target) => window.onceElectron.tabs.create(target, true), url)
    await store()
    // Partitioned: the 127.0.0.1 page does not see what its frame under localhost stored.
    await expectStored({ embedded, firstParty })

    // The embedded site goes everywhere: its own data and its copy inside localhost.
    await window.evaluate(() => window.onceElectron.browsingData.clearSite("127.0.0.1"))
    await expectStored({ embedded: empty, firstParty: empty })

    // The top-level site takes what other sites' frames stored inside it,
    // and leaves those sites' own data alone.
    await store()
    await window.evaluate(() => window.onceElectron.browsingData.clearSite("localhost"))
    await expectStored({ embedded: empty, firstParty })
  } finally {
    await closeApp(electronApp, userData)
    server.close()
  }
})
