const http = require("node:http")
const path = require("node:path")
const { test, expect } = require("./electron-harness")
const { closeApp, launchApp } = require("./electron-harness")

const fixture = path.resolve(__dirname, "../../fixtures/extensions/dnr")

// What the tab fetches, and what a declarativeNetRequest rule of the fixture
// does to each: the static ruleset blocks one and sets a response header on
// another, the dynamic rule the background adds redirects a third, and the
// disabled ruleset leaves the fourth alone.
const PAGE = `<!doctype html><title>DNR fixture page</title><script>
  window.dnrResults = null
  const probe = async (name) => {
    try {
      const response = await fetch("/" + name)
      return { ok: response.ok, url: response.url, text: await response.text(), header: response.headers.get("x-dnr-fixture") }
    } catch (error) {
      return { failed: String(error) }
    }
  }
  Promise.all(["dnr-blocked.txt", "dnr-redirect.txt", "dnr-headers.txt", "dnr-dormant.txt"].map(probe))
    .then(([blocked, redirect, headers, dormant]) => { window.dnrResults = { blocked, redirect, headers, dormant } })
</script><p>DNR fixture</p>`

function startServer() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://localhost")
    if (url.pathname === "/dnr-page") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      response.end(PAGE)
      return
    }
    response.writeHead(200, { "content-type": "text/plain", "x-dnr-fixture": "origin" })
    response.end(url.pathname.slice(1))
  })
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () =>
    resolve({ server, origin: `http://127.0.0.1:${server.address().port}` })
  ))
}

test("declarativeNetRequest rules block, redirect and rewrite headers of a tab's requests", async () => {
  const { server, origin } = await startServer()
  const { electronApp, userData, window } = await launchApp({ env: { ONCE_ELECTRON_EXTENSIONS: fixture } })
  try {
    const inventory = () => window.evaluate(() => window.onceElectron.extensions.list())
    await expect.poll(async () => (await inventory()).map((item) => item.name), { timeout: 15_000 })
      .toContain("Once DNR fixture")
    const extension = (await inventory()).find((item) => item.name === "Once DNR fixture")
    const backgroundPrefix = `moz-extension://${extension.host}/`

    // The background added its dynamic rule and sees the enabled static set.
    const state = () => electronApp.evaluate(async ({ webContents }, prefix) => {
      const background = webContents.getAllWebContents().find((item) => item.getURL().startsWith(prefix))
      return background ? background.executeJavaScript("globalThis.dnrState") : null
    }, backgroundPrefix)
    await expect.poll(async () => (await state())?.ready, { timeout: 15_000 }).toBe(true)
    expect(await state()).toEqual({ ready: true, error: null, enabled: ["static"], dynamic: [100] })

    const pageUrl = `${origin}/dnr-page`
    await window.evaluate((url) => window.onceElectron.tabs.create(url, true), pageUrl)
    const results = () => electronApp.evaluate(async ({ webContents }, url) => {
      const tab = webContents.getAllWebContents().find((item) => item.getURL() === url)
      return tab ? tab.executeJavaScript("window.dnrResults") : null
    }, pageUrl)
    await expect.poll(results, { timeout: 15_000 }).not.toBeNull()
    const { blocked, redirect, headers, dormant } = await results()
    expect(blocked.failed).toMatch(/TypeError/)
    expect(redirect).toMatchObject({ ok: true, url: `${origin}/dnr-redirected.txt`, text: "dnr-redirected.txt" })
    expect(headers).toMatchObject({ ok: true, header: "static" })
    expect(dormant).toMatchObject({ ok: true, text: "dnr-dormant.txt", header: "origin" })
  } finally {
    await closeApp(electronApp, userData)
    server.close()
  }
})
