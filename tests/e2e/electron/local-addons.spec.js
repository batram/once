const { test, expect } = require("@playwright/test")
const fs = require("node:fs/promises")
const os = require("node:os")
const path = require("node:path")
const { launchApp, closeApp, startPageServer, seedLocalSource, openSettingsSection, showAllStories } = require("./electron-harness")
const stories = require("../shared/story-fixture")
const local = require("../shared/local-addon-fixture")

test("ZIP and folder imports use review and survive renderer reload", async () => {
  const server = await startPageServer()
  const { electronApp, userData, window } = await launchApp({ env: { ONCE_ELECTRON_DISABLE_NETWORK_FETCH: "0" } })
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "once-import-"))
  try {
    const href = stories.storyUrls(server.origin).alpha
    await seedLocalSource(window, stories.sourceLine(server.origin), href)
    await openSettingsSection(window, "addons", "#addon_url_input")
    await local.importZip(window)
    await showAllStories(window)
    const badge = window.locator(`[data-href="${href}"] [data-addon-badge="ready"]`)
    await expect(badge).toHaveText("Local package ready")
    await window.reload()
    await window.waitForSelector('body[data-once-ready="true"]')
    await showAllStories(window)
    await window.getByTestId("reload-stories").click()
    await expect(badge).toHaveText("Local package ready")
    for (const [name, text] of Object.entries(local.files("Folder replacement"))) await fs.writeFile(path.join(directory, name), text)
    await openSettingsSection(window, "addons", "#addon_url_input")
    await window.getByTestId("addon-folder-file").setInputFiles(directory)
    await expect(window.getByTestId("confirm-addon")).toHaveText("Apply update")
    await window.getByTestId("confirm-addon").click()
    await showAllStories(window)
    await expect(badge).toHaveText("Folder replacement")
  } finally {
    await closeApp(electronApp, userData)
    await server.close()
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test("packaged Electron loads a picked directory, watches edits, remembers it and unloads", async () => {
  const server = await startPageServer()
  const { electronApp, userData, window } = await launchApp({ env: { ONCE_ELECTRON_DISABLE_NETWORK_FETCH: "0" } })
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "once-linked-"))
  try {
    for (const [name, text] of Object.entries(local.files())) await fs.writeFile(path.join(directory, name), text)
    const href = stories.storyUrls(server.origin).alpha
    await seedLocalSource(window, stories.sourceLine(server.origin), href)
    await openSettingsSection(window, "addons", "#addon_url_input")
    // Supply the OS dialog's selection at the native boundary; exercise the real button and IPC.
    await electronApp.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }) }, directory)
    await window.getByTestId("load-addon-directory").click()
    await expect(window.getByRole("button", { name: "Unload", exact: true })).toBeVisible()
    await showAllStories(window)
    const badge = window.locator(`[data-href="${href}"] [data-addon-badge="ready"]`)
    await expect(badge).toHaveText("Local package ready")
    await fs.writeFile(path.join(directory, "main.js"), local.files("Changed on disk")["main.js"])
    await expect(badge).toHaveText("Changed on disk")
    expect(JSON.parse(await fs.readFile(path.join(userData, "local-addon-directories.json"), "utf8"))).toEqual([directory])
    await openSettingsSection(window, "addons", "#addon_url_input")
    await window.getByRole("button", { name: "Unload", exact: true }).click()
    await showAllStories(window)
    await expect(badge).toHaveCount(0)
    expect(await fs.readFile(path.join(directory, "main.js"), "utf8")).toContain("Changed on disk")
  } finally {
    await closeApp(electronApp, userData)
    await server.close()
    await fs.rm(directory, { recursive: true, force: true })
  }
})
