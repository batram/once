const { test, expect } = require("./electron-harness")
const { launchApp, closeApp, startPageServer, seedLocalSource, openSettingsSection } = require("./electron-harness")
const storyFixture = require("../shared/story-fixture")
const { installAiAddon } = require("../shared/ai-addon-ui")

const ACTION = "addon:what-wait-who-why/explain"
const LABEL = "What? Wait, who, why?"

// The reader can keep a page's add-on conversation beside the page: in the
// Once panel, under a menu entry that lasts until the conversation is closed.
test("a page menu conversation opens in the Once panel when the add-on is set to it", async () => {
  test.setTimeout(60000)
  const server = await startPageServer()
  const { electronApp, userData, window } = await launchApp({ env: { ONCE_ELECTRON_DISABLE_NETWORK_FETCH: "0" } })
  try {
    const urls = storyFixture.storyUrls(server.origin)
    await seedLocalSource(window, storyFixture.sourceLine(server.origin), urls.alpha)
    await openSettingsSection(window, "addons", "#addons_area")
    await installAiAddon(window, server.origin)
    // The add-on's own settings page carries the host's choice of place.
    await window.getByTestId("addon-place-what-wait-who-why").selectOption("panel")

    const page = `${server.origin}/article`
    await window.locator("#urlfield").fill(page)
    await window.locator("#urlfield").press("Enter")
    await expect.poll(() => window.evaluate(url => window.onceElectron.tabs.getAll().then(all => all.find(tab => tab.url === url)?.title), page))
      .toBe("Regenerated Article")
    await electronApp.evaluate(({ Menu }) => {
      globalThis.__onceOriginalBuildFromTemplate = Menu.buildFromTemplate
      Menu.buildFromTemplate = (template) => {
        globalThis.__onceLastMenuTemplate = template
        return { popup() {} }
      }
    })
    await electronApp.evaluate(({ webContents }, pageUrl) => {
      const remote = webContents.getAllWebContents().find((contents) => contents.getURL() === pageUrl)
      remote.emit("context-menu", {}, { x: 4, y: 4, isEditable: false, selectionText: "", pageURL: pageUrl, linkURL: "", linkText: "", editFlags: {} })
    }, page)
    await electronApp.evaluate(({ Menu }, label) => {
      globalThis.__onceLastMenuTemplate.find((item) => item.label === label).click()
      Menu.buildFromTemplate = globalThis.__onceOriginalBuildFromTemplate
    }, LABEL)

    const panel = window.getByTestId("addon-panel")
    await expect(panel).toBeVisible()
    await expect(panel).toContainText("ExampleApp is software", { timeout: 15000 })
    await expect(panel).toContainText("Regenerated Article")
    await expect(window.getByTestId("addon-panel-menu")).toHaveText("WWWW")
    await expect(window.locator("#left_panel")).toHaveAttribute("active_panel", "addon")
    // Beside the page, not in place of it: no conversation tab, the page stays active.
    const tabs = await window.evaluate(() => window.onceElectron.tabs.getAll())
    expect(tabs.filter(tab => tab.url.startsWith("once-addon://"))).toHaveLength(0)
    expect(tabs.find(tab => tab.active)?.url).toBe(page)
    // The entry outlives switching panels and goes with the conversation.
    await window.getByTestId("stories-menu").click()
    await expect(panel).toBeHidden()
    await window.getByTestId("addon-panel-menu").click()
    await expect(panel).toBeVisible()
    await window.getByTestId("addon-panel-close").click()
    await expect(panel).toHaveCount(0)
    await expect(window.getByTestId("addon-panel-menu")).toHaveCount(0)
    await expect(window.locator("#left_panel")).toHaveAttribute("active_panel", "stories")

    // A page that is a listed story: the story stays in view above its conversation.
    await window.locator("#urlfield").fill(urls.alpha)
    await window.locator("#urlfield").press("Enter")
    const selected = window.locator(`#selected_container story-item[data-href="${urls.alpha}"]`)
    await expect(selected).toBeVisible()
    await electronApp.evaluate(({ Menu }) => {
      Menu.buildFromTemplate = (template) => {
        globalThis.__onceLastMenuTemplate = template
        return { popup() {} }
      }
    })
    // The tab's own URL, as the browser settled on it.
    const alphaTab = await window.evaluate(() => window.onceElectron.tabs.getAll().then(all => all.find(tab => tab.active)?.url))
    await electronApp.evaluate(({ webContents }, pageUrl) => {
      const remote = webContents.getAllWebContents().find((contents) => contents.getURL() === pageUrl)
      remote.emit("context-menu", {}, { x: 4, y: 4, isEditable: false, selectionText: "", pageURL: pageUrl, linkURL: "", linkText: "", editFlags: {} })
    }, alphaTab)
    await electronApp.evaluate(({ Menu }, label) => {
      globalThis.__onceLastMenuTemplate.find((item) => item.label === label).click()
      Menu.buildFromTemplate = globalThis.__onceOriginalBuildFromTemplate
    }, LABEL)
    await expect(panel).toContainText("ExampleApp is software", { timeout: 15000 })
    await expect(window.locator("#left_panel")).toHaveAttribute("active_panel", "addon")
    await expect(selected).toBeVisible()
    await expect(window.locator("#stories")).toBeHidden()
    // Laid out like the other panels: its title bar first, then the story, then the conversation.
    const barBox = await window.getByTestId("addon-panel-close").locator("xpath=..").boundingBox()
    const storyBox = await selected.boundingBox()
    const panelBox = await panel.boundingBox()
    expect(barBox.y + barBox.height).toBeLessThanOrEqual(storyBox.y + 1)
    expect(storyBox.y + storyBox.height).toBeLessThanOrEqual(panelBox.y + 1)
    // The menu entry sits under the story filters, not below the status dock at the bottom.
    const filtersBox = await window.locator("#stories_menu_btn").boundingBox()
    const entryBox = await window.getByTestId("addon-panel-menu").boundingBox()
    expect(entryBox.y - (filtersBox.y + filtersBox.height)).toBeLessThan(40)
    await window.screenshot({ path: test.info().outputPath("panel-with-story.png") })
  } finally {
    await closeApp(electronApp, userData)
    await server.close()
  }
})

test("a tray add-on runs on a page that is no story: from the toolbar, and from the page's menu", async () => {
  test.setTimeout(60000)
  const server = await startPageServer()
  const { electronApp, userData, window } = await launchApp({ env: { ONCE_ELECTRON_DISABLE_NETWORK_FETCH: "0" } })
  try {
    const urls = storyFixture.storyUrls(server.origin)
    await seedLocalSource(window, storyFixture.sourceLine(server.origin), urls.alpha)
    await openSettingsSection(window, "addons", "#addons_area")
    await installAiAddon(window, server.origin)
    const action = window.locator(`#page_addon_actions [data-page-addon-action="${ACTION}"]`)
    await expect(action).toHaveAttribute("aria-label", LABEL)
    // The shell's starting tab is no web page, so the button waits.
    await expect(action).toBeDisabled()

    const page = `${server.origin}/article`
    await window.locator("#urlfield").fill(page)
    await window.locator("#urlfield").press("Enter")
    await expect(action).toBeEnabled()
    await expect(window.locator("#selected_container story-item")).toHaveCount(0)
    // The conversation takes the tab's title along, so wait for the page to have one.
    await expect.poll(() => window.evaluate(url => window.onceElectron.tabs.getAll().then(all => all.find(tab => tab.url === url)?.title), page))
      .toBe("Regenerated Article")
    // Reader mode is still the same article target, including without a row.
    await window.locator("#browser_reader").click()
    await expect.poll(() => window.evaluate(() => window.onceElectron.tabs.getAll().then(all => all.find(tab => tab.active)?.url)))
      .toContain("once-reader://")
    await expect(action).toBeEnabled()
    await action.click()
    const conversationUrl = `once-addon://conversation/index.html?addon=what-wait-who-why&tray=assistant&story=${encodeURIComponent(page)}`
    await expect.poll(() => window.evaluate(() => window.onceElectron.tabs.getAll()))
      .toContainEqual(expect.objectContaining({ url: conversationUrl, active: true, loadError: null }))
    const conversation = script => electronApp.evaluate(async ({ webContents }, code) => {
      const found = webContents.getAllWebContents().find(candidate => candidate.getURL().startsWith("once-addon://conversation/"))
      if (!found) return "no conversation page"
      return found.executeJavaScript(code)
    }, script)
    const pageText = () => conversation('document.querySelector(\'[data-testid="addon-conversation"]\')?.textContent ?? "no conversation root"')
    // The addon read the page itself, title and all, and explained it.
    await expect.poll(pageText, { timeout: 15000 }).toContain("ExampleApp is software")
    await expect.poll(pageText).toContain("Regenerated Article")
    // The conversation page is about no story, so nothing is mirrored above the browser.
    await expect(window.locator("#selected_container story-item")).toHaveCount(0)
    // The same page again continues the same conversation rather than starting over.
    const tabs = await window.evaluate(() => window.onceElectron.tabs.getAll())
    const pageTab = tabs.find(tab => tab.url.startsWith("once-reader://"))
    await window.evaluate(id => window.onceElectron.tabs.activate(id), pageTab.id)
    await action.click()
    await expect.poll(() => window.evaluate(() => window.onceElectron.tabs.getAll().then(all => all.filter(tab => tab.url.startsWith("once-addon://")).length))).toBe(2)
    await expect.poll(pageText).toContain("ExampleApp is software")

    // The page's native menu lists the action for the page and for a link under
    // the cursor; the chosen one reaches the renderer and opens its conversation.
    await window.evaluate(id => window.onceElectron.tabs.activate(id), pageTab.id)
    await electronApp.evaluate(({ Menu }) => {
      globalThis.__onceOriginalBuildFromTemplate = Menu.buildFromTemplate
      Menu.buildFromTemplate = (template) => {
        globalThis.__onceLastMenuTemplate = template
        return { popup() {} }
      }
    })
    const linked = `${server.origin}/linked-page`
    await electronApp.evaluate(({ webContents }, [pageUrl, linkUrl]) => {
      const remote = webContents.getAllWebContents().find((contents) => contents.getURL() === pageUrl)
      remote.emit("context-menu", {}, {
        x: 4, y: 4, isEditable: false, selectionText: "", pageURL: pageUrl,
        linkURL: linkUrl, linkText: "A linked page", editFlags: {}
      })
    }, [pageTab.url, linked])
    const labels = await electronApp.evaluate(() => globalThis.__onceLastMenuTemplate.map((item) => item.label || item.type))
    expect(labels.slice(-3)).toEqual(["separator", LABEL, `${LABEL} for Link`])
    await electronApp.evaluate(({ Menu }) => {
      globalThis.__onceLastMenuTemplate.at(-1).click()
      Menu.buildFromTemplate = globalThis.__onceOriginalBuildFromTemplate
    })
    await expect.poll(() => window.evaluate(() => window.onceElectron.tabs.getAll()))
      .toContainEqual(expect.objectContaining({
        url: `once-addon://conversation/index.html?addon=what-wait-who-why&tray=assistant&story=${encodeURIComponent(linked)}`, active: true
      }))
  } finally {
    await closeApp(electronApp, userData)
    await server.close()
  }
})
