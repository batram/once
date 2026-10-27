const { test, expect, launchApp, closeApp, openSettingsSection } = require("./electron-harness")
const fs = require("node:fs/promises")
const os = require("node:os")
const path = require("node:path")
const PouchDB = require("pouchdb")
const expressPouchDB = require("../../helpers/couch-server")

test("changing the sync URL reconnects and persists in the same Electron profile", async () => {
  test.setTimeout(120000)
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "once-url-switch-"))
  const Db = PouchDB.defaults({ prefix: directory + path.sep })
  const first = new Db("first"), second = new Db("second")
  await first.put({ _id: "sync-url-switch-fixture", value: "keep-local-data" })
  const api = expressPouchDB(Db, { mode: "minimumForPouchDB", inMemoryConfig: true })
  const http = await new Promise(resolve => { const server = api.listen(0, "127.0.0.1", () => resolve(server)) })
  const base = `http://127.0.0.1:${http.address().port}`
  let app
  try {
    app = await launchApp({ env: { ONCE_ELECTRON_DISABLE_NETWORK_FETCH: "0" } })
    await openSettingsSection(app.window, "sync", "#couch_input")
    for (const name of ["first", "second"]) {
      await app.window.getByTestId("sync-url").fill(`${base}/${name}`)
      await app.window.getByTestId("save-sync").click()
      await expect(app.window.getByTestId("sync-status")).toHaveAttribute("data-state", "up-to-date", { timeout: 20000 })
    }
    await expect.poll(async () => (await second.get("sync-url-switch-fixture").catch(() => ({}))).value).toBe("keep-local-data")
    const profile = app.userData
    await closeApp(app.electronApp, profile, { keepUserData: true })
    app = null
    app = await launchApp({ userData: profile, env: { ONCE_ELECTRON_DISABLE_NETWORK_FETCH: "0" } })
    await openSettingsSection(app.window, "sync", "#couch_input")
    await expect(app.window.getByTestId("sync-url")).toHaveValue(`${base}/second`)
    await expect(app.window.getByTestId("sync-status")).toHaveAttribute("data-state", "up-to-date", { timeout: 20000 })
  } finally {
    if (app) await closeApp(app.electronApp, app.userData)
    http.closeAllConnections()
    await new Promise(resolve => http.close(resolve))
    await first.destroy(); await second.destroy()
  }
})
