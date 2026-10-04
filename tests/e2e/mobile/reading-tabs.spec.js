const { test, expect } = require("@playwright/test")
const { gotoMobileApp, reloadMobileApp, triggerMobileBack } = require("./helpers/mobile-app")
const { seedFixtureStories, openStoryMenu } = require("./helpers/stories")

const switcher = page => page.locator("#reading_tabs_dialog")
const openTabs = page => page.locator("#reading_tabs").click()
const newTab = async page => {
  await openTabs(page)
  await switcher(page).getByRole("button", { name: "New tab", exact: true }).click()
}

test("background story tabs preserve feed selection; foreground tabs append and ordinary taps reuse", async ({ page }) => {
  const story = await seedFixtureStories(page)
  await openStoryMenu(page, story)
  await page.getByTestId("story-menu-open-background-tab").click()
  await expect(page.locator("#stories_panel")).toBeVisible()
  await openStoryMenu(page, story)
  await page.getByTestId("story-menu-open-new-tab").click()
  await expect(page.locator("#reading_tabs")).toHaveText("2")
  await triggerMobileBack(page)
  await expect(page.locator("#stories_panel")).toBeVisible()
  await story.getByTestId("story-title").click()
  await expect(page.locator("#reading_tabs")).toHaveText("2")
  await openTabs(page)
  await expect(switcher(page).locator(".reading_tab_row")).toHaveCount(2)
})

test("empty tabs, close selection, close-all confirmation, undo and restart restoration", async ({ page }) => {
  await gotoMobileApp(page)
  await page.getByRole("button", { name: "Reading", exact: true }).click()
  await newTab(page)
  await expect(page.locator("#reading_url")).toBeFocused()
  await page.locator("#reading_url").fill("https://first.example/")
  await page.locator("#reading_url").press("Enter")
  await newTab(page)
  await expect(page.locator("#reading_url")).toHaveValue("")
  await page.locator("#reading_url").fill("https://second.example/")
  await page.locator("#reading_url").press("Enter")
  await openTabs(page)
  await switcher(page).getByRole("button", { name: "Close tab: second.example", exact: true }).click()
  await switcher(page).getByRole("button", { name: "Close tab view", exact: true }).click()
  await expect(page.locator("#reading_url")).toHaveValue("https://first.example/")
  await openTabs(page)
  await switcher(page).getByRole("button", { name: "Undo close", exact: true }).click()
  await expect(switcher(page).locator(".reading_tab_row")).toHaveCount(2)
  await switcher(page).getByRole("button", { name: "Close all tabs", exact: true }).click()
  await page.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(switcher(page).getByRole("button", { name: "Close all tabs", exact: true })).toBeFocused()
  await expect(switcher(page).locator(".reading_tab_row")).toHaveCount(2)
  await switcher(page).getByRole("button", { name: "Close all tabs", exact: true }).click()
  await page.locator(".reading_tabs_confirm").getByRole("button", { name: "Close all tabs", exact: true }).click()
  await expect(switcher(page).getByText("No open tabs")).toBeVisible()
  await switcher(page).getByRole("button", { name: "Undo close", exact: true }).click()
  await switcher(page).getByRole("button", { name: "Close tab view", exact: true }).click()
  await reloadMobileApp(page)
  await page.getByRole("button", { name: "Reading", exact: true }).click()
  await expect(page.locator("#reading_url")).toHaveValue("https://second.example/")
  await openTabs(page)
  await expect(switcher(page).locator(".reading_tab_row")).toHaveCount(2)
  await expect(switcher(page).getByRole("button", { name: "Undo close", exact: true })).toBeHidden()
  await triggerMobileBack(page)
  await expect(switcher(page)).not.toBeVisible()
  await expect(page.locator("#reading_tabs")).toBeFocused()
})

test("reader documents survive tab switches and failures belong to their tab", async ({ page }) => {
  const story = await seedFixtureStories(page)
  await openStoryMenu(page, story)
  await page.getByTestId("story-menu-open-reader").click()
  const frame = () => page.locator(".once-reader-host:not([hidden]) iframe").contentFrame()
  await expect(frame().locator("article").first()).toBeVisible()
  await frame().locator("body").evaluate(body => { body.dataset.retained = "original-document" })
  await newTab(page)
  await page.locator("#reading_url").fill(new URL("/fixtures/article.html?second", page.url()).href)
  await page.locator("#reading_url").press("Enter")
  await page.evaluate(() => window.__onceE2E__.failReading("Only the second tab failed"))
  await expect(page.locator("#reading_error")).toBeVisible()
  await openTabs(page)
  await switcher(page).locator('[data-action="select"]').first().click()
  await expect(page.locator("#reading_error")).toBeHidden()
  await expect(frame().locator("body")).toHaveAttribute("data-retained", "original-document")
  await expect(page.locator("#reading_content")).toHaveAttribute("data-load-state", "ready")
  await openTabs(page)
  await switcher(page).locator('[data-action="select"]').last().click()
  await expect(page.locator("#reading_error")).toContainText("Only the second tab failed")
})

test("tab dialog fits phone and tablet viewports in both themes", async ({ page }) => {
  const { openSettingsSection } = require("./helpers/settings")
  await page.addInitScript(() => localStorage.setItem("once:mobile-reading-tabs:v1", JSON.stringify({
    version: 1, activeId: "design", tabs: [
      { id: "design", url: "https://design.example/articles/reading-experiences", title: "Designing a calmer reading experience", mode: "browser", story: null, readerScroll: 0 },
      { id: "docs", url: "https://developer.example/guides/browser-tabs", title: "Browser tabs: keeping your place on the web", mode: "browser", story: null, readerScroll: 0 },
      { id: "url", url: "https://example.test/a-long-article-address-for-tab-layout", title: "", mode: "browser", story: null, readerScroll: 0 },
      { id: "empty", url: "", title: "", mode: "browser", story: null, readerScroll: 0 }
    ]
  })))
  // A real fixture-page screenshot stands in for the native capture bridge.
  const article = await page.context().newPage()
  await article.goto(new URL("/fixtures/article.html", test.info().project.use.baseURL).href)
  const preview = "data:image/jpeg;base64," + (await article.screenshot({ type: "jpeg", quality: 65 })).toString("base64")
  await article.close()
  await gotoMobileApp(page)
  await page.evaluate(preview => window.__onceE2E__.setTabPreview("docs", preview), preview)
  for (const theme of ["light", "dark"]) {
    await openSettingsSection(page, "theme")
    await page.locator("#theme_select").selectOption(theme)
    await page.getByRole("button", { name: "Reading", exact: true }).click()
    await openTabs(page)
    for (const viewport of [{ width: 320, height: 720 }, { width: 412, height: 915 }, { width: 915, height: 412 }, { width: 768, height: 1024 }]) {
      await page.setViewportSize(viewport)
      const geometry = await switcher(page).evaluate(dialog => {
        const box = dialog.getBoundingClientRect()
        const rows = dialog.querySelector(".reading_tab_rows").getBoundingClientRect()
        const header = dialog.querySelector("header").getBoundingClientRect()
        const content = document.querySelector("#reading_content").getBoundingClientRect()
        const address = document.querySelector("#reading_url_form").getBoundingClientRect()
        const menu = document.querySelector("#menu").getBoundingClientRect()
        return { content: { width: content.width, height: content.height, top: content.top }, addressBottom: address.bottom, menuTop: menu.top, bottom: box.bottom, width: box.width, height: box.height, right: box.right, top: box.top, rowsBottom: rows.bottom, headerBottom: header.bottom, rowsTop: rows.top, overflow: document.documentElement.scrollWidth > innerWidth }
      })
      expect(geometry.height).toBeCloseTo(geometry.content.height, 0)
      expect(geometry.width).toBeCloseTo(geometry.content.width, 0)
      expect(geometry.top).toBeGreaterThanOrEqual(geometry.addressBottom)
      expect(geometry.bottom).toBeLessThanOrEqual(geometry.menuTop + 1)
      expect(geometry.right).toBeLessThanOrEqual(viewport.width)
      expect(geometry.top).toBeCloseTo(geometry.content.top, 0)
      expect(geometry.rowsTop).toBeGreaterThanOrEqual(geometry.headerBottom)
      expect(geometry.rowsBottom).toBeLessThanOrEqual(geometry.bottom)
      expect(geometry.overflow).toBe(false)
      await expect(switcher(page).locator("footer")).toHaveCount(0)
      const controls = await switcher(page).locator("header button").evaluateAll(buttons => buttons.map(button => {
        const bounds = button.getBoundingClientRect()
        const icon = button.querySelector(".icon")?.getBoundingClientRect()
        return { name: button.getAttribute("aria-label"), ...bounds.toJSON(),
          iconOffset: icon ? [icon.x + icon.width / 2 - bounds.x - bounds.width / 2, icon.y + icon.height / 2 - bounds.y - bounds.height / 2] : null }
      }))
      expect(controls.map(control => control.name)).toEqual(["Close all tabs", "New tab", "Close tab view"])
      for (const control of controls) {
        expect(control.height).toBe(32)
        expect(control.width).toBeGreaterThanOrEqual(32)
        expect(control.top).toBe(controls[0].top)
        if (control.iconOffset) control.iconOffset.forEach(offset => expect(Math.abs(offset)).toBeLessThan(0.1))
        expect(control.right).toBeLessThanOrEqual(viewport.width)
      }
      await expect(switcher(page).locator(".reading_tab_preview")).toHaveCount(1)
      expect(await switcher(page).locator(".reading_tab_preview").evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true)
      const rows = await switcher(page).locator(".reading_tab_row").evaluateAll(elements => elements.map(row => {
        const select = row.querySelector('[data-action="select"]').getBoundingClientRect()
        const close = row.querySelector('[data-action="close"]').getBoundingClientRect()
        const title = row.querySelector("strong").getBoundingClientRect()
        const detail = row.querySelector(".reading_tab_detail").getBoundingClientRect()
        return { selectHeight: select.height, closeWidth: close.width, closeHeight: close.height, separated: select.right <= close.left, titleHeight: title.height, textInside: detail.right <= close.left }
      }))
      for (const row of rows) {
        expect(row.selectHeight).toBeGreaterThanOrEqual(44)
        expect(row.closeWidth).toBeGreaterThanOrEqual(44)
        expect(row.closeHeight).toBeGreaterThanOrEqual(44)
        expect(row.separated).toBe(true)
        expect(row.textInside).toBe(true)
        expect(row.titleHeight).toBeLessThanOrEqual(44)
      }
      await expect(switcher(page).locator(".reading_tab_row strong").nth(2)).toHaveText("example.test")
      await expect(switcher(page).getByRole("button", { name: "Undo close", exact: true })).toBeHidden()
      if (viewport.width === 412) await page.screenshot({ path: `/tmp/once-tabs-previews-${theme}.png` })
    }
    await switcher(page).getByRole("button", { name: "Close tab view", exact: true }).click()
    await expect(page.locator("#reading_tabs")).toBeFocused()
  }
})

test("tabs occupy reading content while the URL bar and bottom navigation stay usable", async ({ page }) => {
  await gotoMobileApp(page)
  await page.getByRole("button", { name: "Reading", exact: true }).click()
  await newTab(page)
  await openTabs(page)
  await expect(page.locator("#reading_tabs")).toHaveAttribute("aria-expanded", "true")
  await expect(page.locator("#reading_empty")).toBeHidden()
  await page.locator("#reading_url").click()
  await expect(switcher(page)).toBeHidden()
  await expect(page.locator("#reading_url")).toBeFocused()
  await openTabs(page)
  await page.getByRole("button", { name: "Stories", exact: true }).click()
  await expect(switcher(page)).toBeHidden()
  await expect(page.locator("#stories_panel")).toBeVisible()
  await page.getByRole("button", { name: "Reading", exact: true }).click()
  await openTabs(page)
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  await expect(switcher(page)).toBeHidden()
  await expect(page.locator("#settings_panel")).toBeVisible()
  await page.getByRole("button", { name: "Reading", exact: true }).click()
  await openTabs(page)
  await page.locator("#reading_tabs").click()
  await expect(switcher(page)).toBeHidden()
  await openTabs(page)
  await switcher(page).getByRole("button", { name: "Close tab view", exact: true }).press("Escape")
  await expect(switcher(page)).toBeHidden()
  await expect(page.locator("#reading_tabs")).toBeFocused()
  await expect(page.locator("#reading_empty")).toBeVisible()
})

test("reader speech keeps playing across tab switches and the switcher marks playing and played tabs", async ({ page }) => {
  // Fake the host voice so speech never ends on its own and cancels are counted.
  await page.addInitScript(() => {
    if (window.parent !== window) return
    const speech = { spoken: [], cancels: 0 }
    window.__onceSpeech = speech
    Object.defineProperty(window, "speechSynthesis", { configurable: true, value: {
      speaking: false, pending: false, paused: false, onvoiceschanged: null,
      getVoices: () => [{ voiceURI: "fake", name: "Fake voice", lang: "en-US", default: true, localService: true }],
      speak: utterance => { speech.spoken.push(utterance.text) },
      cancel: () => { speech.cancels += 1 },
      pause() {}, resume() {}, addEventListener() {}, removeEventListener() {}
    } })
  })
  const story = await seedFixtureStories(page)
  await openStoryMenu(page, story)
  await page.getByTestId("story-menu-open-reader").click()
  const reader = page.locator(".once-reader-host-frame").first().contentFrame()
  await expect(reader.locator("article .tts-segment")).not.toHaveCount(0)
  await page.locator('[data-host-tts="play"]').click()
  await expect.poll(() => page.evaluate(() => window.__onceSpeech.spoken.length)).toBeGreaterThan(0)
  const cancels = await page.evaluate(() => window.__onceSpeech.cancels)

  await newTab(page)
  await openTabs(page)
  const rows = switcher(page).locator(".reading_tab_row")
  await expect(rows.nth(0).locator(".reading_tab_audio")).toHaveAttribute("data-audio", "playing")
  await expect(rows.nth(0)).toContainText("Playing audio")
  await expect(rows.nth(1).locator(".reading_tab_audio")).toHaveCount(0)
  await rows.nth(0).locator('[data-action="select"]').click()
  await expect(page.locator("#reading_content")).toHaveAttribute("data-mode", "reader")
  await expect(page.locator('[data-host-tts="play"]')).toHaveAttribute("aria-label", "Pause article")
  expect(await page.evaluate(() => window.__onceSpeech.cancels)).toBe(cancels)

  await page.locator('[data-host-tts="stop"]').click()
  await expect.poll(() => page.evaluate(() => window.__onceSpeech.cancels)).toBeGreaterThan(cancels)
  await openTabs(page)
  await expect(rows.nth(0).locator(".reading_tab_audio")).toHaveAttribute("data-audio", "played")
  await expect(rows.nth(0)).toContainText("Played audio")
})
