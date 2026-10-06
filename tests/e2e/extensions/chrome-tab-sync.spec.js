const { chromium } = require("@playwright/test")
const { expect, expectExtensionReady, observeContext, test, waitForExtensionWorker } = require("../shared/browser-evidence")
const fs = require("node:fs/promises")
const os = require("node:os")
const path = require("node:path")
const PouchDB = require("pouchdb")
const expressPouchDB = require("express-pouchdb")
const { startStoryFixture } = require("./local-source")

async function startCouch() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "once-chrome-tabsync-couch-"))
  const Db = PouchDB.defaults({ prefix: directory + path.sep })
  const api = expressPouchDB(Db, { mode: "minimumForPouchDB", inMemoryConfig: true })
  const server = await new Promise((resolve) => { const listening = api.listen(0, "127.0.0.1", () => resolve(listening)) })
  const origin = `http://127.0.0.1:${server.address().port}`
  return {
    url: (name) => `${origin}/${name}`,
    put: async (name, doc) => {
      await fetch(`${origin}/${name}`, { method: "PUT" })
      const response = await fetch(`${origin}/${name}/${doc._id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(doc) })
      if (!response.ok) throw new Error(`Seeding ${doc._id} failed: ${response.status}`)
    },
    devices: async (name) => {
      const response = await fetch(`${origin}/${name}/_all_docs?include_docs=true&startkey=%22dev_%22&endkey=%22dev_%EF%BF%BF%22`)
      if (!response.ok) return []
      return (await response.json()).rows.map((row) => row.doc)
    },
    close: async () => {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
      await fs.rm(directory, { recursive: true, force: true })
    }
  }
}

test("the Chrome background publishes every window's tabs with no panel open, and never follows a URL to another database", async () => {
  const extensionPath = path.resolve(__dirname, "../../../apps/chrome-extension/dist/release")
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "once-chrome-tabsync-"))
  const couch = await startCouch()
  const fixture = await startStoryFixture()
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  })
  try {
    const worker = await waitForExtensionWorker(context)
    await worker.evaluate(async (syncUrl) => {
      await globalThis.chrome.storage.local.set({ "once:e2e:tabsync-timing": { debounce: 100, minInterval: 300 }, "secret:once:tabsync-options": JSON.stringify({ sharing: true }) })
      await globalThis.chrome.storage.sync.set({ sync_url: syncUrl })
    }, couch.url("once"))
    const page = await context.newPage()
    await page.goto(fixture.urls.alpha)
    await worker.evaluate((url) => globalThis.chrome.windows.create({ url }), fixture.urls.beta)

    const published = async () => (await couch.devices("once")).filter((doc) => doc.platform === "chrome")
    await expect.poll(async () => (await published()).map((doc) => doc.windows.flatMap((window) => window.tabs.map((tab) => tab.url)).sort()),
      { timeout: 30_000 }).toEqual([[fixture.urls.alpha, fixture.urls.beta].sort()])
    // Each window's visible tab gets a screenshot, stored under its own record.
    await expect.poll(async () => {
      const [doc] = await published()
      const ids = doc.windows.flatMap((window) => window.tabs.map((tab) => tab.thumb?.id)).filter(Boolean)
      const sizes = await Promise.all(ids.map(async (id) => {
        const response = await fetch(`${couch.url("once")}/${id.split("#")[0]}/thumb.jpg`)
        return response.ok ? (await response.arrayBuffer()).byteLength : 0
      }))
      return sizes.filter((size) => size > 500).length
    }, { timeout: 30_000 }).toBe(2)
    const [first] = await published()
    expect(first.windows.length).toBe(2)
    expect(first.name).toMatch(/^Chrome/)

    await page.goto(fixture.urls.gamma)
    await expect.poll(async () => (await published())[0]?.seq ?? 0, { timeout: 30_000 }).toBeGreaterThan(first.seq)

    // Another installation of this browser profile points sync elsewhere.
    await worker.evaluate((syncUrl) => globalThis.chrome.storage.sync.set({ sync_url: syncUrl }), couch.url("other"))
    await page.goto(fixture.urls.delta)
    // Publishing is due within 0.3 s here; a second and a half would have seen one.
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    expect(await couch.devices("other")).toEqual([])
    const binding = await worker.evaluate(async () => (await globalThis.chrome.storage.local.get("secret:once:sync-destination"))["secret:once:sync-destination"])
    expect(binding).toBe(couch.url("once"))
  } finally {
    await context.close()
    await fixture.close()
    await couch.close()
    await fs.rm(userDataDir, { recursive: true, force: true })
  }
})

test("the side panel's Tabs entry lists other devices' tabs and opens one in a new tab", async () => {
  const extensionPath = path.resolve(__dirname, "../../../apps/chrome-extension/dist/release")
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "once-chrome-tabs-panel-"))
  const couch = await startCouch()
  const fixture = await startStoryFixture()
  const at = new Date().toISOString()
  const remoteTab = (id, url, title) => ({ id, navSeq: 1, url, title, mode: "web", active: false,
    openedAt: at, navigatedAt: at, selectedAt: at, activityAt: at })
  await couch.put("once", { _id: "dev_fedcba9876543210fedcba9876543210", type: "device", schema: 1,
    deviceId: "fedcba9876543210fedcba9876543210", epoch: 1, seq: 3, name: "Test phone", platform: "ios", appVersion: "1",
    sharing: true, updatedAt: at, windows: [{ id: "phone", focused: true, tabs: [remoteTab("a", fixture.urls.epsilon, "Epsilon on the phone")] }] })
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  })
  const evidence = observeContext(context, "extension")
  try {
    const worker = await waitForExtensionWorker(context)
    const extensionId = new URL(worker.url()).host
    const page = await context.newPage()
    await page.goto(`chrome-extension://${extensionId}/static/sidepanel.html?once-e2e=1`)
    await expectExtensionReady(page, evidence)
    const menu = await page.locator("#menu > .sidebar_panel").evaluateAll((items) => items.map((item) => item.dataset.panel))
    expect(menu.indexOf("tabs")).toBe(menu.indexOf("stories") + 1)
    await page.getByTestId("settings-menu").click()
    await page.locator('[data-settings-target="sync"]').click()
    await page.getByTestId("sync-url").fill(couch.url("once"))
    await page.getByTestId("save-sync").click()
    await expect(page.getByTestId("sync-status")).toHaveAttribute("data-state", "up-to-date", { timeout: 20_000 })
    // Until tab sync is turned on, the panel has no Tabs entry.
    await expect(page.getByTestId("tabs-menu")).toBeHidden()
    await page.getByTestId("tab-sync-offer-see").click()
    await page.getByTestId("sync-page-tabs").click()
    await expect(page.getByTestId("tab-sync-share")).toBeVisible()

    await page.getByTestId("tabs-menu").click()
    const panel = page.getByTestId("tabs-panel")
    await expect(panel).toBeVisible()
    await expect(panel.getByTestId("remote-device")).toContainText("Test phone")
    const opened = context.waitForEvent("page")
    await panel.getByText("Epsilon on the phone").click()
    expect((await opened).url()).toBe(fixture.urls.epsilon)
    await panel.screenshot({ path: "artifacts/tab-sync/tabs-panel-chrome.png" })
    await page.screenshot({ path: "artifacts/tab-sync/side-panel-chrome.png" })
  } finally {
    await context.close()
    await fixture.close()
    await couch.close()
    await fs.rm(userDataDir, { recursive: true, force: true })
  }
})

test("the Chrome background reads a media position when its tab is left", async () => {
  const { startMediaServer } = require("../shared/media-server")
  const extensionPath = path.resolve(__dirname, "../../../apps/chrome-extension/dist/release")
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "once-chrome-tabsync-media-"))
  const couch = await startCouch()
  const media = await startMediaServer()
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  })
  try {
    const worker = await waitForExtensionWorker(context)
    await worker.evaluate(async (syncUrl) => {
      await globalThis.chrome.storage.local.set({ "once:e2e:tabsync-timing": { debounce: 100, minInterval: 300 }, "secret:once:tabsync-options": JSON.stringify({ sharing: true, screenshots: false }) })
      await globalThis.chrome.storage.sync.set({ sync_url: syncUrl })
    }, couch.url("once"))
    const page = await context.newPage()
    await page.goto(`${media.origin}/listen`)
    await expect.poll(() => page.evaluate(() => document.querySelector("audio").duration || 0)).toBeGreaterThan(50)
    await page.evaluate(() => { document.querySelector("audio").currentTime = 21 })
    const other = await context.newPage()
    await other.goto(`${media.origin}/elsewhere`)
    await expect.poll(async () => {
      const [doc] = (await couch.devices("once")).filter((item) => item.platform === "chrome")
      const tab = doc?.windows.flatMap((window) => window.tabs).find((item) => item.url === `${media.origin}/listen`)
      return Math.round(tab?.state?.media?.data.currentTime ?? -1)
    }, { timeout: 30_000 }).toBe(21)
  } finally {
    await context.close()
    await media.close()
    await couch.close()
    await fs.rm(userDataDir, { recursive: true, force: true })
  }
})
