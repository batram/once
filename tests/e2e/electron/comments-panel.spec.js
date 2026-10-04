const path = require("node:path")
const { test, expect } = require("./electron-harness")
const { launchApp, closeApp, startPageServer, seedLocalSource, openSettingsSection } = require("./electron-harness")
const storyFixture = require("../shared/story-fixture")

// A story's comments can open in the Once panel beside the page the reader is
// on: under a menu entry that lasts until the panel is closed, in a native view
// that shares the tabs' session rather than in place of the page.
test("comments open in the Once panel beside the current page", async () => {
  test.setTimeout(60000)
  const server = await startPageServer()
  const { electronApp, userData, window } = await launchApp({ env: { ONCE_ELECTRON_DISABLE_NETWORK_FETCH: "0" } })
  // The panel's page as main holds it: not a tab, so found among all contents.
  const panelPage = (script) => electronApp.evaluate(async ({ webContents }, code) => {
    const found = webContents.getAllWebContents().find(contents => contents.getURL().includes("/comments/"))
    return found ? found.executeJavaScript(code) : "no panel page"
  }, script)
  // The native view itself, as laid over the window: shown or not, and where.
  const panelView = () => electronApp.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) {
      const view = window.contentView.children.find(child => child.webContents?.getURL().includes("/comments/"))
      if (view) return { visible: view.getVisible(), bounds: view.getBounds() }
    }
    return null
  })
  try {
    const urls = storyFixture.storyUrls(server.origin)
    await seedLocalSource(window, storyFixture.sourceLine(server.origin), urls.alpha)
    // Reading alpha: it is the story matching the page.
    await window.locator(`#stories story-item[data-href="${urls.alpha}"] a.title`).click()
    const selected = window.locator(`#selected_container story-item[data-href="${urls.alpha}"]`)
    await expect(selected).toBeVisible()

    const beta = window.locator(`#stories story-item[data-href="${urls.beta}"]`)
    // One entry next to each source's comments link.
    await expect(beta.getByTestId("comments-in-panel")).toHaveCount(2)
    await beta.getByTestId("comments-in-panel").first().click()

    const panel = window.getByTestId("comments-panel")
    const entry = window.getByTestId("comments-panel-menu")
    await expect(panel).toBeVisible()
    await expect(window.locator("#left_panel")).toHaveAttribute("active_panel", "comments")
    await expect(entry).toHaveText("Thread")
    await expect(entry).toHaveAttribute("title", "Beta discussion story")
    await expect(window.locator("#comments_panel_bar")).toContainText("Beta discussion story")
    await expect.poll(() => panelPage("document.querySelector('h1')?.textContent")).toBe("Beta-1")
    // Beside the page, not in place of it: no comments tab, alpha stays active.
    const tabs = await window.evaluate(() => window.onceElectron.tabs.getAll())
    expect(tabs.filter(tab => tab.url.includes("/comments/"))).toHaveLength(0)
    expect(tabs.find(tab => tab.active)?.url).toBe(urls.alpha)

    // Laid out like the other panels: title bar, then the matching story, then the page,
    // which fills the room the panel's body keeps for it.
    await expect(selected).toBeVisible()
    await expect(window.locator("#stories")).toBeHidden()
    const barBox = await window.getByTestId("comments-panel-close").locator("xpath=..").boundingBox()
    const storyBox = await selected.boundingBox()
    const body = window.locator("#comments_panel .temporary_panel_body")
    const bodyBox = await body.boundingBox()
    expect(barBox.y + barBox.height).toBeLessThanOrEqual(storyBox.y + 1)
    expect(storyBox.y + storyBox.height).toBeLessThanOrEqual(bodyBox.y + 1)
    await expect.poll(() => panelPage("[innerWidth, innerHeight].join('x')"))
      .toBe(`${Math.round(bodyBox.width)}x${Math.round(bodyBox.height)}`)
    await expect.poll(() => panelView()).toEqual({ visible: true, bounds: {
      x: Math.round(bodyBox.x), y: Math.round(bodyBox.y), width: Math.round(bodyBox.width), height: Math.round(bodyBox.height)
    } })
    await window.screenshot({ path: test.info().outputPath("comments-panel.png") })

    // The entry outlives switching panels; the page hides with its panel.
    await window.getByTestId("stories-menu").click()
    await expect(panel).toBeHidden()
    await expect.poll(() => panelView()).toEqual(expect.objectContaining({ visible: false }))
    await entry.click()
    await expect(panel).toBeVisible()
    await expect.poll(() => panelView()).toEqual(expect.objectContaining({ visible: true }))

    // The story menu offers it too; other comments take the panel's place.
    await window.getByTestId("stories-menu").click()
    await electronApp.evaluate(({ Menu }) => {
      globalThis.__onceOriginalBuildFromTemplate = Menu.buildFromTemplate
      Menu.buildFromTemplate = (template) => {
        globalThis.__onceLastMenuTemplate = template
        return { popup() {} }
      }
    })
    await beta.locator("a.title").click({ button: "right" })
    await expect.poll(() => electronApp.evaluate(() => (globalThis.__onceLastMenuTemplate ?? []).map(item => item.label)))
      .toContain("Open comments in panel")
    await electronApp.evaluate(({ Menu }) => {
      globalThis.__onceLastMenuTemplate.find((item) => item.label === "Open comments in panel").click()
      Menu.buildFromTemplate = globalThis.__onceOriginalBuildFromTemplate
    })
    await expect(window.locator("#left_panel")).toHaveAttribute("active_panel", "comments")
    await expect(entry).toHaveCount(1)
    await expect.poll(() => panelPage("document.querySelector('h1')?.textContent")).toBe("Beta-1")

    // Closing takes the entry and the page along and returns to the stories.
    await window.getByTestId("comments-panel-close").click()
    await expect(panel).toHaveCount(0)
    await expect(entry).toHaveCount(0)
    await expect(window.locator("#left_panel")).toHaveAttribute("active_panel", "stories")
    await expect.poll(() => panelPage("1")).toBe("no panel page")

    // Closed and opened again at once: the old page going away must not take the new panel along.
    await beta.getByTestId("comments-in-panel").first().click()
    await window.getByTestId("comments-panel-close").click()
    await beta.getByTestId("comments-in-panel").first().click()
    await expect.poll(() => panelPage("document.querySelector('h1')?.textContent")).toBe("Beta-1")
    await window.waitForTimeout(500)
    await expect(panel).toBeVisible()
    await expect(window.locator("#left_panel")).toHaveAttribute("active_panel", "comments")
    await window.getByTestId("comments-panel-close").click()
    await expect(panel).toHaveCount(0)

    // With the current story shown below the address bar, the panel is the page alone.
    const position = await openSettingsSection(window, "theme", "#electron_story_position")
    await position.selectOption("browser")
    await window.getByTestId("stories-menu").click()
    await beta.getByTestId("comments-in-panel").nth(1).click()
    await expect(panel).toBeVisible()
    await expect.poll(() => panelPage("document.querySelector('h1')?.textContent")).toBe("Beta-2")
    await expect(window.locator("#left_panel #selected_container")).toHaveCount(0)
    const bodyTop = (await body.boundingBox()).y
    const barBottom = await window.locator("#comments_panel_bar").evaluate(element => element.getBoundingClientRect().bottom)
    expect(bodyTop - barBottom).toBeLessThan(2)

    // "Open in a tab" moves the comments to a tab and closes the panel, which
    // returns to the panel shown before it: here Settings, visited in between.
    await window.getByTestId("settings-menu").click()
    await expect(window.locator("#left_panel")).toHaveAttribute("active_panel", "settings")
    await entry.click()
    await window.locator("#comments_panel_bar").getByRole("button", { name: "Open comments in a tab" }).click()
    await expect(panel).toHaveCount(0)
    await expect(entry).toHaveCount(0)
    await expect(window.locator("#left_panel")).toHaveAttribute("active_panel", "settings")
    await expect.poll(() => window.evaluate(() => window.onceElectron.tabs.getAll().then(all => all.find(tab => tab.active)?.url)))
      .toBe(urls.betaSubstoryComments)
  } finally {
    await closeApp(electronApp, userData)
    await server.close()
  }
})

// Userscripts, blockers and themes apply to the panel's page as to a tab's:
// content scripts run there and their sender is a tab extensions can look up.
test("extensions reach the comments in the Once panel", async () => {
  test.setTimeout(60000)
  const server = await startPageServer()
  const { electronApp, userData, window } = await launchApp({ env: {
    ONCE_ELECTRON_DISABLE_NETWORK_FETCH: "0",
    ONCE_ELECTRON_EXTENSIONS: path.resolve(__dirname, "../../fixtures/extensions/content-probe")
  } })
  const panelPage = (script) => electronApp.evaluate(async ({ webContents }, code) => {
    const found = webContents.getAllWebContents().find(contents => contents.getURL().includes("/comments/"))
    return found ? found.executeJavaScript(code) : "no panel page"
  }, script)
  try {
    await expect.poll(async () => (await window.evaluate(() => window.onceElectron.extensions.list())).map(item => item.name),
      { timeout: 15_000 }).toContain("Once content probe fixture")
    const urls = storyFixture.storyUrls(server.origin)
    await seedLocalSource(window, storyFixture.sourceLine(server.origin), urls.alpha)
    await window.locator(`#stories story-item[data-href="${urls.alpha}"] a.title`).click()
    await window.locator(`#stories story-item[data-href="${urls.beta}"]`).getByTestId("comments-in-panel").first().click()
    await expect.poll(() => panelPage("document.querySelector('h1')?.textContent")).toBe("Beta-1")

    expect(await panelPage("document.documentElement.dataset.contentProbe")).toBe("ran")
    await expect.poll(() => panelPage("document.documentElement.dataset.contentProbeReply ?? null")).not.toBeNull()
    const reply = JSON.parse(await panelPage("document.documentElement.dataset.contentProbeReply"))
    expect(reply.tabId).toEqual(reply.found)
    expect(reply.tabId).not.toBeNull()
    expect(reply.tabUrl).toContain("/comments/")

    // Still no tab of its own in the strip.
    const tabs = await window.evaluate(() => window.onceElectron.tabs.getAll())
    expect(tabs.filter(tab => tab.url.includes("/comments/"))).toHaveLength(0)
  } finally {
    await closeApp(electronApp, userData)
    await server.close()
  }
})
