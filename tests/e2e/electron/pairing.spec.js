const { test, expect } = require("./electron-harness")
const fs = require("node:fs/promises")
const os = require("node:os")
const path = require("node:path")
const PouchDB = require("pouchdb")
const expressPouchDB = require("express-pouchdb")
const { launchApp, closeApp, openSettingsSection } = require("./electron-harness")

test("a pairing code shows behind a warning, and its link connects another profile after asking", async () => {
  test.setTimeout(90000)
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "once-pairing-"))
  const Db = PouchDB.defaults({ prefix: directory + path.sep })
  const api = expressPouchDB(Db, { mode: "minimumForPouchDB", inMemoryConfig: true })
  const http = await new Promise((resolve) => { const server = api.listen(0, "127.0.0.1", () => resolve(server)) })
  const origin = `127.0.0.1:${http.address().port}`
  const first = await launchApp({ env: { ONCE_ELECTRON_DISABLE_NETWORK_FETCH: "0" } })
  let second
  try {
    const page = first.window
    await openSettingsSection(page, "sync", "#couch_input")
    await page.getByTestId("sync-url").fill(`http://${origin}/once`)
    await page.getByTestId("save-sync").click()
    await expect(page.getByTestId("sync-status")).toHaveAttribute("data-state", "up-to-date", { timeout: 20000 })

    await page.getByTestId("pair-show").click()
    const panel = page.getByTestId("pair-panel")
    await expect(panel).toContainText("This code contains your sync password")
    await panel.getByTestId("pair-make").click()
    const code = panel.getByTestId("pair-code")
    await expect(code).toHaveAttribute("data-blurred", "true")
    await code.click()
    await expect(code).toHaveAttribute("data-blurred", "false")
    await expect(code.locator("svg path")).toHaveAttribute("d", /^M/)
    await panel.getByTestId("pair-copy").click()
    await expect(panel.getByTestId("pair-copy")).toHaveText("Copied")
    const link = await first.electronApp.evaluate(({ clipboard }) => clipboard.readText())
    expect(link).toMatch(/^once:\/\/pair\?v=1&u=/)
    await panel.screenshot({ path: "artifacts/tab-sync/pairing-code-electron.png" })

    second = await launchApp({ env: { ONCE_ELECTRON_DISABLE_NETWORK_FETCH: "0" } })
    const other = second.window
    await openSettingsSection(other, "sync", "#couch_input")
    await other.getByTestId("pair-link").fill(link)
    await other.getByTestId("pair-connect").click()
    const confirm = other.getByTestId("pair-confirm")
    await expect(confirm).toContainText(`Connect to ${origin}/once?`)
    await confirm.getByRole("button", { name: "Connect" }).click()
    await expect(other.getByTestId("sync-status")).toHaveAttribute("data-state", "up-to-date", { timeout: 20000 })
    await expect(other.getByTestId("pair-status")).toHaveText("Connected")
    await expect(other.getByTestId("pair-link")).toHaveValue("")

    // The profile is now bound to that database: a link to another one is refused.
    const elsewhere = link.replace(/u=[\w-]+/, `u=${Buffer.from(`http://${origin}/other`).toString("base64url")}`)
    await other.getByTestId("pair-link").fill(elsewhere)
    await other.getByTestId("pair-connect").click()
    await other.getByTestId("pair-confirm").getByRole("button", { name: "Connect" }).click()
    await expect(other.getByTestId("pair-status")).toContainText("separate Once profile")
  } finally {
    if (second) await closeApp(second.electronApp, second.userData)
    await closeApp(first.electronApp, first.userData)
    http.closeAllConnections()
    await new Promise((resolve) => http.close(resolve))
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test("a pairing code can carry the add-on sync passphrase, which unlocks add-on sync on the other profile", async () => {
  test.setTimeout(120000)
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "once-pairing-vault-"))
  const Db = PouchDB.defaults({ prefix: directory + path.sep })
  const api = expressPouchDB(Db, { mode: "minimumForPouchDB", inMemoryConfig: true })
  const http = await new Promise((resolve) => { const server = api.listen(0, "127.0.0.1", () => resolve(server)) })
  const first = await launchApp({ env: { ONCE_ELECTRON_DISABLE_NETWORK_FETCH: "0" } })
  let second
  try {
    const page = first.window
    await openSettingsSection(page, "sync", "#couch_input")
    await page.getByTestId("sync-url").fill(`http://127.0.0.1:${http.address().port}/once`)
    await page.getByTestId("save-sync").click()
    await expect(page.getByTestId("sync-status")).toHaveAttribute("data-state", "up-to-date", { timeout: 20000 })
    const vault = page.locator("#addon_vault_controls")
    await vault.locator("summary").click()
    await vault.getByTestId("addon-vault-secret").fill("pairing passphrase for tests")
    await vault.getByLabel("Confirm sync passphrase").fill("pairing passphrase for tests")
    await vault.getByRole("button", { name: "Enable encrypted addon sync" }).click()
    await expect(vault.getByTestId("addon-vault-status")).toContainText("Ready", { timeout: 10000 })
    await vault.getByRole("button", { name: "I saved my recovery key" }).click()

    await page.getByTestId("pair-show").click()
    const panel = page.getByTestId("pair-panel")
    await panel.getByTestId("pair-include-passphrase").check()
    await expect(panel).toContainText("also opens your synced add-on tokens")
    await panel.getByTestId("pair-passphrase").fill("not the passphrase")
    await panel.getByTestId("pair-make").click()
    await expect(panel).toContainText("That passphrase does not open add-on sync")
    await panel.getByTestId("pair-passphrase").fill("pairing passphrase for tests")
    await panel.getByTestId("pair-make").click()
    await panel.getByTestId("pair-copy").click()
    await expect(panel.getByTestId("pair-copy")).toHaveText("Copied")
    const link = await first.electronApp.evaluate(({ clipboard }) => clipboard.readText())
    expect(link).toMatch(/&p=/)

    second = await launchApp({ env: { ONCE_ELECTRON_DISABLE_NETWORK_FETCH: "0" } })
    const other = second.window
    await openSettingsSection(other, "sync", "#couch_input")
    await other.getByTestId("pair-link").fill(link)
    await other.getByTestId("pair-connect").click()
    await expect(other.getByTestId("pair-confirm")).toContainText("unlocks add-on sync")
    await other.getByTestId("pair-confirm").getByRole("button", { name: "Connect" }).click()
    await expect(other.getByTestId("pair-status")).toHaveText("Connected; add-on sync is unlocked", { timeout: 30000 })
    await expect(other.getByTestId("addon-vault-status")).toContainText("Ready")
  } finally {
    if (second) await closeApp(second.electronApp, second.userData)
    await closeApp(first.electronApp, first.userData)
    http.closeAllConnections()
    await new Promise((resolve) => http.close(resolve))
    await fs.rm(directory, { recursive: true, force: true })
  }
})
