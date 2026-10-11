const { test, expect } = require("./electron-harness")
const crypto = require("node:crypto")
const http = require("node:http")
const { closeApp, launchApp, openSettingsSection, seedLocalSource, showAllStories } = require("./electron-harness")

// An add-on with a collector that picks a mirror and a dynamic redirect, the
// shape of the bundled Nitter add-on, against two "mirrors" on one server: the
// one reached as 127.0.0.1 is down (503), the one reached as localhost works.
let server
let down
let up
const requests = []

const SCRIPT = () => `export default function activate(once) {
  const DOWN = ${JSON.stringify(down)}, UP = ${JSON.stringify(up)}
  let feed = DOWN
  let page = DOWN
  once.collectors.register("feed", {
    resolveUrl: () => feed + "/feed.json",
    failed: () => { if (feed === UP) return false; feed = UP; return true },
    parse: (body) => body.items.map((item) => ({ href: item.url, title: item.title }))
  })
  once.redirects.register("to-mirror", {
    target: () => page + "/$1",
    failed: () => { if (page === UP) return null; page = UP; return page + "/$1" }
  })
}
`

const MANIFEST = () => [{
  protocol: 1,
  id: "mirror-harness",
  name: "Mirror Harness",
  version: "1.0.0",
  script: { url: `${down}/addon/main.js`, integrity: `sha256-${crypto.createHash("sha256").update(SCRIPT(), "utf8").digest("base64")}` },
  capabilities: ["fetch:http://*/*"],
  contributions: [],
  collectors: [{ id: "feed", type: "MH", description: "Mirrored feed", pattern: ["http://mirrored.test/*"], collects: "json" }],
  redirects: [{ id: "to-mirror", title: "Harness mirror", match: "^http://mirrored\\.test/(.*)$", dynamic: true }]
}]

test.beforeAll(async () => {
  server = http.createServer((request, response) => {
    const isDown = (request.headers.host || "").startsWith("127.0.0.1")
    requests.push(`${isDown ? "down" : "up"} ${request.url}`)
    if (request.url === "/addon/main.js") {
      response.writeHead(200, { "content-type": "text/javascript" })
      response.end(SCRIPT())
    } else if (isDown) {
      response.writeHead(503, { "content-type": "text/html" })
      response.end("<title>Down</title>Mirror down")
    } else if (request.url === "/feed.json") {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ items: [{ url: "http://mirrored.test/post/1", title: "Mirrored one" }] }))
    } else {
      response.writeHead(200, { "content-type": "text/html" })
      response.end("<title>Up page</title>Mirror up")
    }
  })
  // Unspecified host: both 127.0.0.1 and localhost (::1 included) reach it.
  await new Promise((resolve) => server.listen(0, resolve))
  const { port } = server.address()
  down = `http://127.0.0.1:${port}`
  up = `http://localhost:${port}`
})

test.afterAll(async () => {
  await new Promise((resolve) => server.close(resolve))
})

test("an add-on redirect shows in the Redirects panel, fails over with its collector and tabs, and switches off", async () => {
  const { electronApp, userData, window } = await launchApp({ env: { ONCE_ELECTRON_DISABLE_NETWORK_FETCH: "0" } })
  try {
    const editor = await openSettingsSection(window, "addons", "#addons_area")
    await editor.evaluate((textarea, value) => { textarea.value = value }, JSON.stringify(MANIFEST(), null, 2))
    await window.getByTestId("save-addons").evaluate((button) => button.click())
    await expect(window.locator('[data-settings-target="addons"] .settings_section_summary')).toHaveText("1 add-on")

    await openSettingsSection(window, "redirects")
    const row = window.locator('[data-addon-redirect="addon:mirror-harness/to-mirror"]')
    await expect(row.getByTestId("addon-redirect-target")).toHaveText(`Mirror Harness · => ${new URL(down).host}`, { timeout: 15_000 })
    await expect(row.getByTestId("addon-redirect-toggle")).toBeChecked()

    // The collector's first mirror answers 503; the loader lets it move once.
    await seedLocalSource(window, JSON.stringify({ version: 2, groups: [], sources: [{ id: "src_mirror001", url: "http://mirrored.test/feed" }] }), "http://mirrored.test/post/1")
    expect(requests).toContain("down /feed.json")
    expect(requests).toContain("up /feed.json")

    await showAllStories(window)
    const story = window.locator('#stories story-item[data-href="http://mirrored.test/post/1"]')
    await expect(story).toHaveAttribute("data-redirected_url", `${down}/post/1`)

    // A tab on the dead mirror moves to the live one, and the rule follows.
    await window.evaluate((url) => window.onceElectron.tabs.create(url, true), `${down}/post/1`)
    await expect.poll(async () => (await window.evaluate(() => window.onceElectron.tabs.getAll())).map((tab) => tab.url), { timeout: 15_000 })
      .toContainEqual(`${up}/post/1`)
    await expect(story).toHaveAttribute("data-redirected_url", `${up}/post/1`)

    await openSettingsSection(window, "redirects")
    await expect(row.getByTestId("addon-redirect-target")).toHaveText(`Mirror Harness · => ${new URL(up).host}`)
    await row.getByTestId("addon-redirect-toggle").uncheck()
    await expect(row.getByTestId("addon-redirect-toggle")).not.toBeChecked()
    await showAllStories(window)
    await expect(story).toHaveAttribute("data-redirected_url", "http://mirrored.test/post/1")
  } finally {
    await closeApp(electronApp, userData)
  }
})
