const { test, expect, launchApp, closeApp, openSettingsSection } = require("./electron-harness")
const fs = require("node:fs/promises")
const os = require("node:os")
const path = require("node:path")
const PouchDB = require("pouchdb")
const expressPouchDB = require("../../helpers/couch-server")
const { copyWinningRevisions } = require("../../../packages/persistence/dist")

test("an installed client keeps local preferences and its old database through an epoch and pointer loss", async () => {
  test.setTimeout(120000)
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "once-installed-epoch-"))
  const Db = PouchDB.defaults({ prefix: directory + path.sep })
  const source = new Db("once"), target = new Db("once_e2")
  const api = expressPouchDB(Db, { mode: "minimumForPouchDB", inMemoryConfig: true })
  const http = await new Promise(resolve => { const server = api.listen(0, "127.0.0.1", () => resolve(server)) })
  const url = `http://127.0.0.1:${http.address().port}/once`
  let app
  try {
    app = await launchApp({ env: { ONCE_ELECTRON_DISABLE_NETWORK_FETCH: "0" } })
    await app.window.evaluate(() => localStorage.setItem("once:epoch-test-local-preference", "keep-me"))
    await openSettingsSection(app.window, "sync", "#couch_input")
    await app.window.getByTestId("sync-url").fill(url)
    await app.window.getByTestId("save-sync").click()
    await expect(app.window.getByTestId("sync-status")).toHaveAttribute("data-state", "up-to-date", { timeout: 20000 })
    const profile = app.userData
    await closeApp(app.electronApp, profile, { keepUserData: true })
    app = null
    const compatibility = await source.get("once_sync_compat").catch(error => { if (error.status === 404) return {}; throw error })
    await source.put({ ...compatibility, _id: "once_sync_compat", schema: 1, minSyncProtocol: 4 })
    await copyWinningRevisions(source, target, "installed-client-fixture")
    await source.put({ _id: "once_sync_epoch", schema: 1, state: "ready", next: "once_e2" })
    app = await launchApp({ userData: profile, env: { ONCE_ELECTRON_DISABLE_NETWORK_FETCH: "0" } })
    const pointerKey = "once:local-database:once_electron_v2"
    const readPointer = async () => {
      try { return await app.window.evaluate(key => localStorage.getItem(key), pointerKey) }
      catch (error) {
        if (error.message.includes("Execution context was destroyed")) return null
        throw error
      }
    }
    await expect.poll(readPointer, { timeout: 30000 }).not.toBeNull()
    const pointer = await app.window.evaluate(key => localStorage.getItem(key), pointerKey)
    expect(await app.window.evaluate(() => localStorage.getItem("once:epoch-test-local-preference"))).toBe("keep-me")
    const databases = await app.window.evaluate(async () => (await indexedDB.databases()).map(db => db.name))
    expect(databases).toContain("_pouch_once_electron_v2")
    expect(databases).toContain("_pouch_" + JSON.parse(pointer).name)
    await app.window.evaluate(key => localStorage.removeItem(key), pointerKey)
    await app.window.reload()
    await expect.poll(readPointer, { timeout: 30000 }).toBe(pointer)
    expect(await app.window.evaluate(() => localStorage.getItem("once:epoch-test-local-preference"))).toBe("keep-me")
  } finally {
    if (app) await closeApp(app.electronApp, app.userData)
    http.closeAllConnections()
    await new Promise(resolve => http.close(resolve))
    // express-pouchdb retains its catalog handle until worker exit on Windows.
    await source.destroy(); await target.destroy()
  }
})
