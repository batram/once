const { test, expect } = require("@playwright/test")
const {
  closeApp,
  launchApp,
  openSettingsSection,
  seedLocalSource,
  showAllStories,
  startPageServer
} = require("./electron-harness")
const storyFixture = require("../shared/story-fixture")

const STORY_ENV = { env: { ONCE_ELECTRON_DISABLE_NETWORK_FETCH: "0" } }

let pageServer
let origin
let urls

test.beforeAll(async () => {
  pageServer = await startPageServer()
  origin = pageServer.origin
  urls = storyFixture.storyUrls(origin)
})

test.afterAll(async () => {
  await pageServer.close()
})

// A declarative add-on: no code, one action on every surface and one badge.
// Saved through the Add-ons settings editor, it has to show up on the rows,
// in the swipe lab's choices, in the keybinding editor, and its button has
// to open the templated URL in a tab.
const MANIFEST = (origin) => [{
  protocol: 1,
  id: "harness-archive",
  name: "Harness Archive",
  version: "1.0.0",
  contributions: [
    {
      kind: "action",
      id: "open-archive",
      label: "Open harness archive",
      icon: "article",
      surfaces: ["button", "menu", "swipe", "key"],
      when: { scheme: ["http"] },
      run: { open: `${origin}/archive?u={href}`, target: "blank" }
    },
    { kind: "badge", id: "host", text: "via {domain}" }
  ]
}]

test("a declarative add-on contributes a row button, a badge, a swipe action, and a key command", async () => {
  const { electronApp, userData, window } = await launchApp(STORY_ENV)
  try {
    await seedLocalSource(window, storyFixture.sourceLine(origin), urls.alpha)

    const editor = await openSettingsSection(window, "addons", "#addons_area")
    await editor.evaluate((textarea, value) => {
      textarea.value = value
    }, JSON.stringify(MANIFEST(origin), null, 2))
    await window.getByTestId("save-addons").evaluate((button) => button.click())
    await expect(window.locator('[data-settings-target="addons"] .settings_section_summary'))
      .toHaveText("1 of 1 enabled")

    await showAllStories(window)
    const alpha = window.locator(`#stories story-item[data-href="${urls.alpha}"]`)
    const button = alpha.locator('.addon_btn[data-story-element="addon:harness-archive/open-archive"]')
    await expect(button).toBeVisible()
    await expect(button).toHaveAttribute("title", "Open harness archive")
    await expect(alpha.locator(".addon_badge")).toHaveText("via 127.0.0.1")

    await button.click()
    await expect.poll(async () =>
      (await window.evaluate(() => window.onceElectron.tabs.getAll())).map((tab) => tab.url)
    ).toContainEqual(`${origin}/archive?u=${encodeURIComponent(urls.alpha)}`)

    const swipeSelect = await openSettingsSection(window, "swipe", '[data-testid="swipe-right-1"]')
    await expect(swipeSelect.locator('option[value="addon:harness-archive/open-archive"]'))
      .toHaveText("Open harness archive")

    await openSettingsSection(window, "keyboard", "#keyboard_shortcuts")
    await expect(window.locator(
      '.keybinding_row[data-command="story-action.addon:harness-archive/open-archive"]'
    )).toBeVisible()

    // Switching the add-on off in the editor takes everything with it.
    const again = await openSettingsSection(window, "addons", "#addons_area")
    await again.evaluate((textarea, value) => {
      textarea.value = value
    }, JSON.stringify(MANIFEST(origin).map((entry) => ({ enabled: false, ...entry })), null, 2))
    await window.getByTestId("save-addons").evaluate((button) => button.click())
    await expect(window.locator('[data-settings-target="addons"] .settings_section_summary'))
      .toHaveText("0 of 1 enabled")
    await showAllStories(window)
    await expect(alpha.locator(".addon_btn")).toHaveCount(0)
    await expect(alpha.locator(".addon_badge")).toHaveCount(0)
  } finally {
    await closeApp(electronApp, userData)
  }
})

test("a manifest with a problem is refused with the problem named, and nothing changes", async () => {
  const { electronApp, userData, window } = await launchApp()
  try {
    const editor = await openSettingsSection(window, "addons", "#addons_area")
    const broken = MANIFEST("http://127.0.0.1:1")
    broken[0].contributions[0].run = { open: "javascript:alert(1)" }
    await editor.evaluate((textarea, value) => {
      textarea.value = value
    }, JSON.stringify(broken))
    await window.getByTestId("save-addons").evaluate((button) => button.click())
    const status = window.locator('[data-settings-section="addons"] .settings_status')
    await expect(status).toContainText("Could not save")
    await expect(status).toContainText("contributions[0].run.open")
    expect(await window.evaluate(() => window.onceElectron.tabs.getAll())).toHaveLength(1)
  } finally {
    await closeApp(electronApp, userData)
  }
})
