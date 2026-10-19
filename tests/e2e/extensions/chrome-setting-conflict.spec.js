const { test, expect, expectExtensionReady, waitForExtensionWorker } = require("../shared/browser-evidence")
const { launchExtensionChrome } = require("../shared/extension-chrome")
const fs = require("node:fs/promises")
const os = require("node:os")
const path = require("node:path")
const PouchDB = require("pouchdb")
const couchServer = require("../../helpers/couch-server")

for (const policy of ["single", "synced", "local"]) test(`Chrome migrates after an explicit ${policy} settings choice`, async () => {
  test.setTimeout(90000)
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "once-chrome-setting-review-"))
  const Db = PouchDB.defaults({ prefix: directory + path.sep })
  const api = couchServer(Db, { mode: "minimumForPouchDB", inMemoryConfig: true })
  const old = new Db("once"), canonical = new Db("once_e2")
  const story = { _id: "sto_https://servo.org/blog/2026/10/09/august-in-servo/",
    href: "https://servo.org/blog/2026/10/09/august-in-servo/", title: "August in Servo",
    type: "rss", timestamp: 1, comment_url: "", tags: [], substories: [], read_state: "unread", stared: false, filter: "" }
  const device = { _id: "dev_22f450d8f2a8d74b4b2feb6af6ae2e85", type: "device", schema: 1,
    deviceId: "22f450d8f2a8d74b4b2feb6af6ae2e85", epoch: 1, seq: 1, name: "Returning Chrome",
    platform: "chrome", appVersion: "test", sharing: false, windows: [], updatedAt: "2026-10-19T08:00:00Z" }
  await old.bulkDocs([
    ...(policy !== "single" ? [{ _id: "animation", _rev: "1-a", list: false }, { _id: "animation", _rev: "1-z", list: true }] : []),
    { ...story, _rev: "1-local", stared: true, sync_updated_at: { stared: 100 } },
    { ...device, _rev: "1-local" },
    { _id: "swipe", _rev: "2-a", _revisions: { start: 2, ids: ["a", "root"] }, list: { twoStage: false } },
    { _id: "swipe", _rev: "2-b", _revisions: { start: 2, ids: ["b", "root"] }, list: { twoStage: true } },
    { _id: "once_sync_compat", _rev: "1-protocol", schema: 1, minSyncProtocol: 4 }
  ], { new_edits: false })
  const server = await new Promise(resolve => { const listening = api.listen(0, "127.0.0.1", () => resolve(listening)) })
  const origin = `http://127.0.0.1:${server.address().port}`
  const browser = await launchExtensionChrome({ profilePrefix: "once-chrome-setting-review-" })
  try {
    await browser.context.route(/^https?:/, route => route.request().url().startsWith(origin) ? route.continue() : route.abort())
    const worker = await waitForExtensionWorker(browser.context)
    const panelUrl = `chrome-extension://${new URL(worker.url()).host}/static/sidepanel.html?once-e2e=1`
    let page = await browser.context.newPage()
    await page.goto(panelUrl); await expectExtensionReady(page, browser.evidence)
    await page.getByTestId("settings-menu").click()
    await page.locator('[data-settings-target="sync"]').click()
    await page.getByTestId("sync-url").fill(origin + "/once")
    await page.getByTestId("save-sync").click()
    await expect(page.getByTestId("sync-status")).toHaveAttribute("data-state", "up-to-date", { timeout: 20000 })
    await page.close()
    const rows = (await old.allDocs({ include_docs: true })).rows.filter(row => row.id !== "swipe" && row.id !== device._id && row.id !== story._id && (policy === "single" || row.id !== "animation"))
    const docs = await old.bulkGet({ docs: rows.map(row => ({ id: row.id, rev: row.doc._rev })), revs: true, attachments: true })
    await canonical.bulkDocs(docs.results.flatMap(row => row.docs.map(entry => entry.ok)), { new_edits: false })
    await canonical.bulkDocs([{ ...device, _rev: "1-canonical", seq: 2 }], { new_edits: false })
    await canonical.bulkDocs([{ ...story, _rev: "1-canonical", title: "Canonical Servo title" }], { new_edits: false })
    if (policy !== "single") await canonical.bulkDocs([{ _id: "animation", _rev: "1-canonical", list: false }], { new_edits: false })
    await canonical.bulkDocs([{ _id: "swipe", _rev: "3-c", _revisions: { start: 3, ids: ["c", "a", "root"] }, list: { twoStage: false } }], { new_edits: false })
    await old.put({ _id: "once_sync_epoch", schema: 1, state: "ready", next: "once_e2" })
    page = await browser.context.newPage()
    await page.goto(panelUrl); await expectExtensionReady(page, browser.evidence)
    await page.getByTestId("settings-menu").click()
    await page.locator('[data-settings-target="sync"]').click()
    const review = page.getByTestId("sync-setting-review")
    await expect(review).toBeVisible({ timeout: 20000 })
    await review.getByRole("button", { name: "Review versions" }).click()
    await expect(review.locator("input[type=radio]")).toHaveCount(2)
    const apply = review.getByRole("button", { name: "Use selected version and resume sync" })
    await expect(apply).toBeDisabled()
    await review.screenshot({ path: test.info().outputPath("setting-review.png") })
    expect(await page.evaluate(() => localStorage.getItem("once:local-database:once_db"))).toBeNull()
    if (policy === "single") {
      await review.locator("label").filter({ hasText: "Synced version" }).locator("input").check()
      await apply.click()
      await page.getByRole("button", { name: "Use this version", exact: true }).click()
    } else {
      await review.getByRole("button", { name: policy === "synced" ? "Use synced for all" : "Use current local for all", exact: true }).click()
      await page.getByRole("button", { name: "Apply to all settings conflicts", exact: true }).click()
    }
    await expect.poll(async () => {
      try { return await page.evaluate(() => localStorage.getItem("once:local-database:once_db")) }
      catch { return null } // the committed migration reloads the renderer
    }, { timeout: 30000 }).not.toBeNull()
    await expectExtensionReady(page, browser.evidence)
    await expect(page.getByTestId("sync-status")).toHaveAttribute("data-state", "up-to-date", { timeout: 20000 })
    if (policy !== "local") expect((await canonical.get("swipe"))._rev).toBe("3-c")
    await expect.poll(async () => (await canonical.get("swipe")).list.twoStage).toBe(policy === "local")
    if (policy !== "single") await expect.poll(async () => (await canonical.get("animation")).list).toBe(policy === "local")
    expect((await canonical.get(device._id)).seq).toBe(2)
    expect((await canonical.get(device._id))._rev).toBe("1-canonical")
    await expect.poll(async () => (await canonical.get(story._id)).stared).toBe(true)
    expect((await canonical.get(story._id)).title).toBe("Canonical Servo title")
    expect((await canonical.get(story._id, { conflicts: true }))._conflicts).toBeUndefined()
  } finally {
    await browser.close(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await old.destroy(); await canonical.destroy() })
    // express-pouchdb retains its catalog handle until the worker exits.
  }
})
