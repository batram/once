const { test, expect } = require("@playwright/test")
const crypto = require("node:crypto")
const fs = require("node:fs/promises")
const os = require("node:os")
const path = require("node:path")
const {
  ADDON_SCRIPT,
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

// A scripted add-on: its code is fetched, hash-checked, and run in the sandbox
// frame. The badge is computed by the script, the button hands the invocation
// to it, and an operation on a story it was not asked about is refused.
const SCRIPTED_MANIFEST = (origin) => [{
  protocol: 1,
  id: "harness-script",
  name: "Harness Script",
  version: "1.0.0",
  script: {
    url: `${origin}/addon/main.js`,
    integrity: `sha256-${crypto.createHash("sha256").update(ADDON_SCRIPT, "utf8").digest("base64")}`
  },
  contributions: [
    { kind: "action", id: "visit", label: "Visit from add-on", surfaces: ["button"], run: { message: "visit" } },
    { kind: "action", id: "sneak", label: "Sneak elsewhere", surfaces: ["button"], run: { message: "sneak" } },
    { kind: "badge", id: "len", compute: "len" }
  ]
}]

test("a scripted add-on runs in the sandbox: computed badges, message actions, scoped operations", async () => {
  const { electronApp, userData, window } = await launchApp(STORY_ENV)
  try {
    await seedLocalSource(window, storyFixture.sourceLine(origin), urls.alpha)
    const editor = await openSettingsSection(window, "addons", "#addons_area")
    await editor.evaluate((textarea, value) => {
      textarea.value = value
    }, JSON.stringify(SCRIPTED_MANIFEST(origin), null, 2))
    await window.getByTestId("save-addons").evaluate((button) => button.click())
    await expect(window.locator('[data-settings-target="addons"] .settings_section_summary'))
      .toHaveText("1 of 1 enabled")

    await showAllStories(window)
    const alpha = window.locator(`#stories story-item[data-href="${urls.alpha}"]`)
    const title = await alpha.locator("a.title").innerText()
    await expect(alpha.locator('.addon_badge[data-addon-badge="len"]')).toHaveText(`len ${title.length}`)
    expect(await window.locator("iframe[data-addon-sandbox]").count()).toBe(1)

    await alpha.locator('.addon_btn[data-story-element="addon:harness-script/visit"]').click()
    await expect.poll(async () =>
      (await window.evaluate(() => window.onceElectron.tabs.getAll())).map((tab) => tab.url)
    ).toContainEqual(urls.alpha.replace(/\/[^/]*$/, "/from-addon"))

    await alpha.locator('.addon_btn[data-story-element="addon:harness-script/sneak"]').click()
    await openSettingsSection(window, "errors", "#error_log")
    await expect(window.locator("#error_log")).toContainText(/not asked about/)
    const tabs = await window.evaluate(() => window.onceElectron.tabs.getAll())
    expect(tabs.some((tab) => tab.url.startsWith("https://elsewhere.test"))).toBe(false)
  } finally {
    await closeApp(electronApp, userData)
  }
})

// A collector add-on: the script parses a JSON feed Once fetched and cached,
// its stories carry the collector's badge, and a plain URL line in the sources
// is enough because the manifest's pattern matches it.
const COLLECTOR_MANIFEST = (origin) => [{
  ...SCRIPTED_MANIFEST(origin)[0],
  id: "harness-collector",
  name: "Harness Collector",
  contributions: [],
  collectors: [{
    id: "json", type: "HX", description: "Harness JSON feed", collects: "json",
    pattern: [`${origin}/api/*`], colors: ["#336699", "white"]
  }]
}]

test("a collector add-on turns a JSON feed into stories with its own badge", async () => {
  const { electronApp, userData, window } = await launchApp(STORY_ENV)
  try {
    const editor = await openSettingsSection(window, "addons", "#addons_area")
    await editor.evaluate((textarea, value) => {
      textarea.value = value
    }, JSON.stringify(COLLECTOR_MANIFEST(origin), null, 2))
    await window.getByTestId("save-addons").evaluate((button) => button.click())
    await expect(window.locator('[data-settings-target="addons"] .settings_section_summary'))
      .toHaveText("1 of 1 enabled")

    // The fixture's sources document plus one plain source; the collector is
    // detected from the add-on's pattern, not named.
    const sources = JSON.parse(storyFixture.sourceLine(origin))
    sources.sources.push({ id: "src_addon0001", url: `${origin}/api/stories.json` })
    await seedLocalSource(window, JSON.stringify(sources), urls.alpha)
    await showAllStories(window)
    const one = window.locator(`#stories story-item[data-href="${origin}/api-story/1"]`)
    await expect(one).toBeVisible({ timeout: 15_000 })
    await expect(one).toHaveAttribute("data-type", "[HX]")
    await expect(one.locator("a.title")).toHaveText("Addon One (/api/stories.json)")
    await expect(one).toHaveAttribute("data-comment_url", `${origin}/api-comments/1`)
    await expect(window.locator(`#stories story-item[data-href="${origin}/api-story/2"]`)).toBeVisible()
  } finally {
    await closeApp(electronApp, userData)
  }
})

// Installing from a URL: the manifest's relative script URL resolves against
// it, the entry remembers where it came from, and an update check that finds
// the same version changes nothing.
test("an add-on installs from its manifest URL and reports on an update check", async () => {
  const { electronApp, userData, window } = await launchApp(STORY_ENV)
  try {
    await seedLocalSource(window, storyFixture.sourceLine(origin), urls.alpha)
    const urlInput = await openSettingsSection(window, "addons", '[data-testid="addon-url"]')
    await urlInput.evaluate((input, value) => {
      input.value = value
    }, `${origin}/addon/once-addon.json`)
    await window.getByTestId("install-addon").evaluate((button) => button.click())
    const status = window.locator("#addon_install_settings .settings_status")
    await expect(status).toHaveText("Installed Harness Package 2.0.0")
    await expect(window.locator("#addons_area")).toHaveValue(/"source": \{\s*"url": "http/)
    await expect(window.locator("#addons_area")).toHaveValue(new RegExp(`"url": "${origin}/addon/main.js"`))

    await showAllStories(window)
    const alpha = window.locator(`#stories story-item[data-href="${urls.alpha}"]`)
    const title = await alpha.locator("a.title").innerText()
    await expect(alpha.locator('.addon_badge[data-addon-badge="len"]')).toHaveText(`len ${title.length}`)

    await openSettingsSection(window, "addons", '[data-testid="update-addons"]')
    await window.getByTestId("update-addons").evaluate((button) => button.click())
    await expect(status).toHaveText("1 checked, nothing new")
  } finally {
    await closeApp(electronApp, userData)
  }
})

// Capabilities: a panel button asks the script, which fetches within its
// fetch: grant and stores the answer in its storage; an option the user
// changes reaches the script and shows in a computed badge.
const CAPABLE_MANIFEST = (origin) => [{
  ...SCRIPTED_MANIFEST(origin)[0],
  id: "harness-capable",
  name: "Harness Capable",
  capabilities: ["fetch:http://127.0.0.1/*"],
  settings: {
    type: "object",
    properties: {
      suffix: { type: "string", description: "Badge suffix", default: "" },
      feed: { type: "string", default: `${origin}/api/stories.json` }
    }
  },
  panelActions: [{ id: "count-feed", label: "Count the feed", icon: "reload", run: { message: "count-feed" } }],
  contributions: [{ kind: "badge", id: "len", compute: "len" }]
}]

test("capabilities: a panel action fetches within its grant and stores, and options reach the script", async () => {
  const { electronApp, userData, window } = await launchApp(STORY_ENV)
  try {
    await seedLocalSource(window, storyFixture.sourceLine(origin), urls.alpha)
    const editor = await openSettingsSection(window, "addons", "#addons_area")
    await editor.evaluate((textarea, value) => {
      textarea.value = value
    }, JSON.stringify(CAPABLE_MANIFEST(origin), null, 2))
    await window.getByTestId("save-addons").evaluate((button) => button.click())
    await expect(window.locator('[data-settings-target="addons"] .settings_section_summary'))
      .toHaveText("1 of 1 enabled")

    await showAllStories(window)
    const alpha = window.locator(`#stories story-item[data-href="${urls.alpha}"]`)
    const title = await alpha.locator("a.title").innerText()
    await expect(alpha.locator('.addon_badge[data-addon-badge="len"]')).toHaveText(`len ${title.length}`)

    const panelButton = window.locator('#addon_panel_actions .addon_panel_btn[data-story-element="addon:harness-capable/count-feed"]')
    await expect(panelButton).toBeVisible()
    await panelButton.click()
    await openSettingsSection(window, "addons", "#addons_area")
    await expect(editor).toHaveValue(/"storage": \{\s*"count": 2\s*\}/, { timeout: 10_000 })

    const suffix = window.getByTestId("addon-option-harness-capable-suffix")
    await expect(suffix).toBeVisible()
    await suffix.fill("!")
    await suffix.dispatchEvent("change")
    await expect(editor).toHaveValue(/"options": \{\s*"suffix": "!"/, { timeout: 10_000 })
    await showAllStories(window)
    await expect(alpha.locator('.addon_badge[data-addon-badge="len"]')).toHaveText(`len ${title.length}!`)
  } finally {
    await closeApp(electronApp, userData)
  }
})

// A development add-on: a directory named in ONCE_ADDONS with once-addon.json
// beside main.js. Main reads it, pins the script by hash, and the renderer
// registers it without any settings interaction or document entry.
test("ONCE_ADDONS directories load as development add-ons in unpackaged builds", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "once-addons-dev-"))
  await fs.writeFile(path.join(dir, "once-addon.json"), JSON.stringify({
    protocol: 1,
    id: "dev-harness",
    name: "Dev Harness",
    version: "0.0.1",
    script: "main.js",
    contributions: [{ kind: "badge", id: "len", compute: "len" }]
  }))
  await fs.writeFile(path.join(dir, "main.js"), ADDON_SCRIPT)
  const { electronApp, userData, window } = await launchApp({
    env: { ...STORY_ENV.env, ONCE_ADDONS: dir }
  })
  try {
    await seedLocalSource(window, storyFixture.sourceLine(origin), urls.alpha)
    await showAllStories(window)
    const alpha = window.locator(`#stories story-item[data-href="${urls.alpha}"]`)
    const title = await alpha.locator("a.title").innerText()
    await expect(alpha.locator('.addon_badge[data-addon-badge="len"]')).toHaveText(`len ${title.length}`, { timeout: 15_000 })
    expect(await window.locator("iframe[data-addon-sandbox]").count()).toBe(1)
    // Nothing reached the synced document.
    const editor = await openSettingsSection(window, "addons", "#addons_area")
    await expect(editor).toHaveValue("")
  } finally {
    await closeApp(electronApp, userData)
    await fs.rm(dir, { recursive: true, force: true })
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
