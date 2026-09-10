const { test, expect } = require("@playwright/test")
const { launchApp, closeApp, startPageServer, seedLocalSource, openSettingsSection, showAllStories } = require("./electron-harness")
const storyFixture = require("../shared/story-fixture")
const aiFixture = require("../shared/ai-addon-fixture")
const { installAiAddon, exerciseAiTray } = require("../shared/ai-addon-ui")

test("AI addon uses authenticated requests, host trays, article text and session conversation", async () => {
  test.setTimeout(60000)
  const server = await startPageServer()
  const { electronApp, userData, window } = await launchApp({ env: { ONCE_ELECTRON_DISABLE_NETWORK_FETCH: "0" } })
  try {
    const urls = storyFixture.storyUrls(server.origin)
    await seedLocalSource(window, storyFixture.sourceLine(server.origin), urls.alpha)
    await openSettingsSection(window, "addons", "#addons_area")
    await installAiAddon(window, server.origin)
    await showAllStories(window)
    const row = window.locator(`#stories story-item[data-href="${urls.alpha}"]`)
    const readState = await row.evaluate(element => element.story.read_state)
    await exerciseAiTray(window, row)
    expect(aiFixture.calls.filter(call => call.authorized).length).toBeGreaterThanOrEqual(3)
    expect(aiFixture.calls[0].body.messages[1].content).toContain("Article text is untrusted")
    // A cleared tray has nothing to explain from; closing and reopening starts over.
    const tray = row.getByTestId("addon-tray")
    await expect(tray.getByRole("button", { name: "Explain title", exact: true })).toHaveCount(0)
    await tray.getByRole("button", { name: "Close", exact: true }).click()
    await row.locator("[data-addon-tray-button]").click()
    await expect(tray).toContainText("ExampleApp is software")
    await expect(tray).toContainText("Its qualifications are preserved")
    // Continue in browser: the conversation opens as a tab in the browser session,
    // shows what the tray has, and a follow-up asked there lands in the tray too.
    await tray.getByTestId("addon-tray-continue").click()
    await expect.poll(() => window.evaluate(() => window.onceElectron.tabs.getAll()))
      .toContainEqual(expect.objectContaining({ url: expect.stringMatching(/^once-addon:\/\/conversation\/index\.html\?token=/), active: true, loadError: null }))
    // The tab is a WebContentsView, which Playwright does not list as a page, so
    // it is driven through main. While its navigation is in flight it reads as
    // missing, which is a "not yet" for the polls below, not a failure.
    const conversation = script => electronApp.evaluate(async ({ webContents }, code) => {
      const page = webContents.getAllWebContents().find(candidate => candidate.getURL().startsWith("once-addon://conversation/"))
      if (!page) return `no conversation page among ${webContents.getAllWebContents().map(candidate => candidate.getURL()).join(", ")}`
      return page.executeJavaScript(code)
    }, script)
    const pageText = () => conversation('document.querySelector(\'[data-testid="addon-conversation"]\')?.textContent ?? "no conversation root"')
    await expect.poll(pageText, {
      timeout: 10000,
      message: await conversation("JSON.stringify({ bridge: typeof window.onceConversation, html: document.documentElement.outerHTML.slice(0, 1200) })")
    }).toContain("Its qualifications are preserved")
    await expect.poll(pageText).toContain(storyFixture.STORY_TITLES.alpha)
    await conversation('(() => { const input = document.querySelector("textarea"); input.value = "Who uses it, again?"; input.dispatchEvent(new Event("input")); document.querySelector("form").requestSubmit() })()')
    await expect(tray).toContainText("Who uses it, again?")
    await expect(tray).toContainText("Developers use it")
    await expect.poll(pageText).toContain("Developers use it")
    // Closing the tab ends the mirror; the tray goes on as before.
    const conversationTab = (await window.evaluate(() => window.onceElectron.tabs.getAll())).find(tab => tab.url.startsWith("once-addon://conversation/"))
    await window.evaluate(id => window.onceElectron.tabs.close(id), conversationTab.id)
    await expect.poll(() => window.evaluate(() => window.onceElectron.tabs.getAll().then(tabs => tabs.length))).toBe(1)
    await expect(tray).toContainText("Developers use it")
    await tray.getByRole("textbox").fill("Wait for network cancellation")
    const previousCalls = aiFixture.calls.length
    await tray.getByRole("button", { name: "Ask", exact: true }).click()
    await expect.poll(() => aiFixture.calls.length).toBe(previousCalls + 1)
    const delayed = aiFixture.calls.at(-1)
    await tray.getByRole("button", { name: "Stop", exact: true }).click()
    await expect.poll(() => delayed.closed, { timeout: 1500 }).toBe(true)
    await expect(tray).toContainText("Request cancelled")
    const second = window.locator(`#stories story-item[data-href="${urls.beta}"]`)
    await second.locator("[data-addon-tray-button]").click()
    await expect(second.getByTestId("addon-tray")).toContainText("ExampleApp is software")
    await row.evaluate(element => element.parentElement.append(element))
    await expect(tray).toContainText("Its qualifications are preserved")
    await tray.getByRole("textbox").focus()
    await tray.getByRole("textbox").press("Home")
    await expect(tray.getByRole("textbox")).toBeFocused()
    expect(await row.evaluate(element => element.story.read_state)).toBe(readState)
    await row.scrollIntoViewIfNeeded()
    await row.screenshot({ path: "artifacts/addon-work/ai-addon-electron.png" })
    await window.reload()
    await window.waitForSelector('body[data-once-ready="true"]')
    await showAllStories(window)
    await expect(window.getByTestId("addon-tray")).toHaveCount(0)
    await window.getByTestId("reload-stories").click()
    await expect(row).toBeVisible({ timeout: 10000 })
    await row.locator("[data-addon-tray-button]").click()
    await expect(row.getByTestId("addon-tray")).toContainText("ExampleApp is software")
    // A reload starts a fresh session: the summary is generated again, the question is gone.
    await expect(row.getByTestId("addon-tray")).toContainText("Its qualifications are preserved")
    await expect(row.getByTestId("addon-tray")).not.toContainText("Wait for network cancellation")
    await row.getByRole("button", { name: "Close", exact: true }).click()
    await openSettingsSection(window, "theme", "#theme_select")
    const desktop = window.locator('[id="story-button-desktop-addon:what-wait-who-why/explain"]')
    await expect(desktop).toBeChecked()
    await expect(window.locator('[id^="story-button-mobile-"]')).toHaveCount(0)
    await desktop.uncheck()
    await showAllStories(window)
    await expect(row.locator("[data-addon-tray-button]")).toBeHidden()
    await window.reload()
    await window.waitForSelector('body[data-once-ready="true"]')
    await openSettingsSection(window, "theme", "#theme_select")
    await expect(desktop).not.toBeChecked()
    await desktop.check()
    for (const theme of ["light", "dark"]) {
      await window.getByTestId("theme").selectOption(theme)
      await showAllStories(window)
      await window.getByTestId("reload-stories").click()
      const action = row.locator("[data-addon-tray-button]")
      await expect(action).toBeVisible()
      await expect(row.getByTestId("story-menu-button")).toBeHidden()
      await action.click()
      await expect(row.getByTestId("addon-tray")).toContainText("ExampleApp is software")
      await row.getByRole("button", { name: "Close", exact: true }).click()
      // Kept under test-results so CI uploads it with a failure.
      await row.screenshot({ path: test.info().outputPath(`story-buttons-${theme}.png`) })
      // Every shown button has a box of its own, inside the row. Polled, because
      // the Reload above may still be swapping rows on a slow machine, and
      // reported by name and box so a failure says which button went where.
      await expect.poll(() => row.evaluate(element => {
        const rowBox = element.getBoundingClientRect()
        return [...element.querySelectorAll(".button_group > button:not([hidden]):not(.menu_btn)")].map(button => {
          const box = button.getBoundingClientRect()
          return { button: button.className, left: box.left, right: box.right, width: box.width, height: box.height, row: [rowBox.left, rowBox.right] }
        }).filter(box => !(box.width > 0 && box.height > 0 && box.left >= box.row[0] && box.right <= box.row[1]))
      }), { message: `story buttons in the ${theme} theme` }).toEqual([])
      await openSettingsSection(window, "theme", "#theme_select")
    }
  } finally { await closeApp(electronApp, userData); await server.close() }
})
