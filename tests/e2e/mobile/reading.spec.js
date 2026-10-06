const { test, expect } = require("@playwright/test")
const {
  gotoMobileApp,
  reloadMobileApp,
  testServerUrl
} = require("./helpers/mobile-app")
const {
  openSettingsSection,
  saveSourcesAndWait
} = require("./helpers/settings")
const { openStoryMenu, seedFixtureStories } = require("./helpers/stories")

test("a redirected story remains matched in the Reading view", async ({ page }) => {
  const story = await seedFixtureStories(page)
  const redirectedUrl = await testServerUrl(
    page,
    "/fixtures/articles/redirected.html"
  )

  await openSettingsSection(page, "redirects")
  await page.getByTestId("redirects").fill(
    `${await testServerUrl(page, "/fixtures/article.html")} => ${redirectedUrl}`
  )
  await page.getByTestId("save-redirects").click()
  await page.getByTestId("stories-menu").click()

  const title = story.getByTestId("story-title")
  await expect(title).toHaveAttribute("href", redirectedUrl)
  await title.click()

  await expect(page.locator("#reading_url")).toHaveValue(redirectedUrl)
  await expect(page.getByTestId("reading-current-card")).toBeVisible()
})

test("the current Reading story reflects bookmark changes", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 })
  const story = await seedFixtureStories(page)
  await openStoryMenu(page, story)
  await page.getByTestId("story-menu-open").click()

  const currentCard = page.getByTestId("reading-current-card")
  const collapse = page.getByTestId("reading-story-collapse")
  await expect(currentCard).toBeVisible()
  await page.locator("#reading_story_menu").click()
  await expect(page.getByTestId("story-menu")).toBeVisible()
  await page.getByTestId("story-menu-toggle-bookmark").click()

  await expect(currentCard).toHaveClass(/\bstared\b/)
  await page.locator("#reading_story_menu").click()
  await expect(page.getByTestId("story-menu-toggle-bookmark"))
    .toHaveText("Remove bookmark")
  await page.getByTestId("story-menu-backdrop").click({ position: { x: 5, y: 5 } })

  await expect(collapse).toHaveAttribute("aria-expanded", "true")
  await collapse.click()
  await expect(currentCard).toHaveClass(/\breading_story_collapsed\b/)
  await expect(collapse).toHaveAttribute("aria-expanded", "false")
  await expect(page.locator("#reading_comments")).toBeHidden()
  await expect(page.locator("#reading_type")).toBeVisible()
  await expect(page.locator("#reading_type")).not.toHaveText("")
  await expect(page.locator("#reading_story_time")).toBeHidden()
  await expect(page.locator("#reading_story_tags")).toBeHidden()
  expect(await currentCard.evaluate(
    (card) => card.getBoundingClientRect().height
  )).toBeLessThanOrEqual(40)

  const geometry = await currentCard.evaluate((card) => {
    const cardBox = card.getBoundingClientRect()
    const source = card.querySelector("#reading_type").getBoundingClientRect()
    const title = card.querySelector("#reading_title").getBoundingClientRect()
    const collapseButton = card.querySelector("#reading_story_collapse")
      .getBoundingClientRect()
    const menuButton = card.querySelector("#reading_story_menu")
      .getBoundingClientRect()
    return {
      collapseSize: [collapseButton.width, collapseButton.height],
      menuSize: [menuButton.width, menuButton.height],
      controlsGap: menuButton.left - collapseButton.right,
      controlsInsideCard: [collapseButton, menuButton].every(
        (item) => item.top >= cardBox.top && item.bottom <= cardBox.bottom
      ),
      contentClearControls: title.right <= collapseButton.left,
      oneLine: [source, title].every(
        (item) => item.top >= cardBox.top && item.bottom <= cardBox.bottom
      ) && Math.abs(
        (source.top + source.bottom) / 2 -
        (title.top + title.bottom) / 2
      ) < 2,
      compactHeight: cardBox.height
    }
  })
  expect(geometry.collapseSize).toEqual([28, 28])
  expect(geometry.menuSize).toEqual([28, 28])
  expect(geometry.controlsGap).toBe(2)
  expect(geometry.controlsInsideCard).toBe(true)
  expect(geometry.contentClearControls).toBe(true)
  expect(geometry.oneLine).toBe(true)
  expect(geometry.compactHeight).toBeLessThanOrEqual(40)

  await page.locator("#reading_type").click()
  await expect(page.locator("#reading_content")).toHaveAttribute(
    "data-mode",
    "comments"
  )
  await expect(currentCard).toHaveClass(/\breading_story_collapsed\b/)
  await expect(page.locator("#reading_title")).toHaveAttribute(
    "aria-label",
    "Open story"
  )

  await page.locator("#reading_title").click()
  await expect(page.locator("#reading_content")).toHaveAttribute(
    "data-mode",
    "browser"
  )
  await expect(currentCard).toHaveClass(/\breading_story_collapsed\b/)

  await collapse.click()
  await expect(currentCard).not.toHaveClass(/\breading_story_collapsed\b/)
  expect(await currentCard.evaluate(
    (card) => card.getBoundingClientRect().height
  )).toBeGreaterThan(40)
  const box = await currentCard.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2, box.y + 4, { steps: 4 })
  await page.mouse.up()
  await expect(currentCard).toHaveClass(/\breading_story_collapsed\b/)
})

// The gesture is measured from where the finger went down, not from the first
// move the swipe handler happens to see — that one arrives only after the axis
// lock resolves, and a flick has covered most of its distance by then.

test("the current story card remembers its collapsed state and Appearance can set it", async ({ page }) => {
  const story = await seedFixtureStories(page)
  const currentCard = page.getByTestId("reading-current-card")
  const collapse = page.getByTestId("reading-story-collapse")
  // The e2e build loads no stories on its own, so a reload needs the same
  // explicit fetch the seeding helper makes.
  const openFixtureStory = async () => {
    await page.getByTestId("stories-menu").click()
    await page.getByTestId("reload-stories").click()
    const row = page.getByTestId("story").filter({ hasText: "Fixture article" })
    await expect(row).toBeVisible()
    await openStoryMenu(page, row)
    await page.getByTestId("story-menu-open").click()
    await expect(currentCard).toBeVisible()
  }

  await openStoryMenu(page, story)
  await page.getByTestId("story-menu-open").click()
  await expect(currentCard).toBeVisible()
  await expect(collapse).toHaveAttribute("aria-expanded", "true")
  await collapse.click()
  await expect(currentCard).toHaveClass(/\breading_story_collapsed\b/)

  // The choice outlives the story: a fresh open starts collapsed, and the
  // Appearance select shows the remembered state.
  await reloadMobileApp(page)
  await openFixtureStory()
  await expect(currentCard).toHaveClass(/\breading_story_collapsed\b/)
  await expect(collapse).toHaveAttribute("aria-expanded", "false")
  await openSettingsSection(page, "theme")
  const cardState = page.getByTestId("mobile-story-card-state")
  await expect(cardState).toBeVisible()
  await expect(cardState).toHaveValue("collapsed")

  // Choosing a default in Settings is the same remembered choice.
  await cardState.selectOption("expanded")
  await reloadMobileApp(page)
  await openFixtureStory()
  await expect(currentCard).not.toHaveClass(/\breading_story_collapsed\b/)
  await expect(collapse).toHaveAttribute("aria-expanded", "true")
  expect(await page.evaluate(() => localStorage.getItem("once:mobile-story-card-state")))
    .toBe("expanded")
})

test("reader TTS bridges through the host when the frame lacks speech synthesis", async ({ page }) => {
  // Simulate the Android WebView reader frame, which has no Web Speech API.
  await page.addInitScript(() => {
    if (window.parent !== window) {
      Object.defineProperty(window, "speechSynthesis", { configurable: true, value: undefined })
      Object.defineProperty(window, "SpeechSynthesisUtterance", { configurable: true, value: undefined })
    }
  })
  await gotoMobileApp(page)
  await openSettingsSection(page, "sources")
  await page.getByTestId("sources").fill(await testServerUrl(page, "/fixtures/feed.rss"))
  await saveSourcesAndWait(page)
  await reloadMobileApp(page)
  await page.getByTestId("stories-menu").click()
  await page.getByTestId("reload-stories").click()

  const story = page.getByTestId("story").filter({ hasText: "Fixture article" })
  await expect(story).toBeVisible()
  await openStoryMenu(page, story)
  await page.getByTestId("story-menu-open-reader").click()
  await expect(page.locator("#reading_content")).toHaveAttribute("data-mode", "reader")
  const reader = page.locator(".once-reader-host-frame").contentFrame()
  await expect(reader.locator("html")).toHaveAttribute("data-once-tts-installed", "true")
  // the polyfill bridges to the host, so TTS stays available instead of disabled
  await expect(reader.getByTestId("tts-unavailable")).toHaveCount(0)
  await expect(reader.locator("[data-tts-play]")).toBeEnabled()
  await expect(reader.locator("article .tts-segment")).not.toHaveCount(0)
  await expect(page.locator("#reader_tts_voice option").filter({
    hasText: "Wafli SLT — offline"
  })).toHaveCount(1)
  await page.locator("#reader_tts_voice").evaluate((select) => {
    select.value = "once-wafli-slt"
    select.dispatchEvent(new Event("change", { bubbles: true }))
  })
  await page.locator('[data-host-tts="play"]').click()
  await expect.poll(() => reader.locator("html").evaluate(() =>
    performance.getEntriesByType("resource").some((entry) =>
      entry.name.endsWith("/wafli-module.wasm")
    )
  )).toBe(true)
  await page.locator('[data-host-tts="stop"]').click()
})

test("reader speech remembers the chosen voice and a speed per voice", async ({ page }) => {
  const story = await seedFixtureStories(page)
  const openReader = async (open) => {
    await open()
    const reader = page.locator(".once-reader-host-frame").contentFrame()
    await expect(reader.locator("html")).toHaveAttribute("data-once-tts-installed", "true")
    await expect(page.locator("#reader_tts_voice option").filter({
      hasText: "Wafli SLT — offline"
    })).toHaveCount(1)
  }
  const voice = page.locator("#reader_tts_voice")
  const rateLabel = page.locator("#reader_tts_rate_label")
  const chooseVoice = (value) => voice.evaluate((select, chosen) => {
    select.value = chosen
    select.dispatchEvent(new Event("change", { bubbles: true }))
  }, value)
  const chooseRate = async (label) => {
    await page.locator("#reader_tts_settings > summary").click()
    await page.locator("#reader_tts_rates button", { hasText: label }).click()
  }

  await openReader(async () => {
    await openStoryMenu(page, story)
    await page.getByTestId("story-menu-open-reader").click()
  })
  await expect(rateLabel).toHaveText("1×")
  await chooseRate("2×")
  await expect(rateLabel).toHaveText("2×")
  // A voice never adjusted starts at the default voice's speed.
  await chooseVoice("once-wafli-slt")
  await expect(rateLabel).toHaveText("2×")
  await chooseRate("1.25×")
  await expect(rateLabel).toHaveText("1.25×")
  await chooseVoice("")
  await expect(rateLabel).toHaveText("2×")
  await chooseVoice("once-wafli-slt")
  await expect(rateLabel).toHaveText("1.25×")

  // The sandboxed reader frame has no lasting storage; the host keeps both
  // for the restored reader tab's fresh frame.
  await reloadMobileApp(page)
  await openReader(() => page.getByTestId("reading-menu").click())
  await expect(voice).toHaveValue("once-wafli-slt")
  await expect(rateLabel).toHaveText("1.25×")
  await chooseVoice("")
  await expect(rateLabel).toHaveText("2×")
})

test("Reader mode explains failures and offers clean recovery", async ({ page }) => {
  let attempts = 0
  await page.route("**/fixtures/reader-failure*", async (route) => {
    attempts += 1
    if (attempts < 3) {
      await route.fulfill({
        status: 503,
        contentType: "text/plain",
        body: "temporarily unavailable"
      })
      return
    }
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `<!doctype html><title>Recovered article</title><article>
        <h1>Recovered article</h1>
        <p>${"Reader recovery content. ".repeat(80)}</p>
      </article>`
    })
  })

  await gotoMobileApp(page)
  await page.getByTestId("reading-menu").click()
  const url = await testServerUrl(page, "/fixtures/reader-failure")
  await page.getByTestId("reading-url-input").fill(url)
  await page.getByTestId("reading-url-input").press("Enter")
  await page.locator("#reading_reader_toggle").click()

  const status = page.getByTestId("reading-reader-status")
  await expect(status).toBeVisible()
  await expect(page.getByTestId("reading-reader-error")).toBeVisible()
  await expect(page.locator("#reading_reader_error_message"))
    .toContainText("HTTP 503")
  await expect(page.getByTestId("reader-tts-bar")).toBeHidden()

  await page.locator("#reading_reader_open_page").click()
  await expect(page.locator("#reading_content")).toHaveAttribute(
    "data-mode",
    "browser"
  )
  await expect(status).toBeHidden()

  await page.locator("#reading_reader_toggle").click()
  await expect(page.getByTestId("reading-reader-error")).toBeVisible()
  await page.locator("#reading_reader_retry").click()
  await expect(page.getByTestId("reading-reader-loading")).toBeVisible()

  const reader = page.locator(".once-reader-host-frame").contentFrame()
  await expect(reader.getByRole("heading", { name: "Recovered article" }))
    .toBeVisible()
  await expect(status).toBeHidden()
  await expect(page.locator("#reading_content")).toHaveAttribute(
    "data-load-state",
    "ready"
  )
  await expect(page.getByTestId("reader-tts-bar")).toBeVisible()
  expect(attempts).toBe(3)
})


test("the optional reader button opens the mobile Reading session on tap", async ({ page }) => {
  const story = await seedFixtureStories(page)
  await openSettingsSection(page, "theme")
  await page.locator('[id="story-button-mobile-builtin/outline"]').check()
  await page.getByTestId("stories-menu").click()
  await story.getByTestId("story-reader").tap()
  await expect(page.locator("#reading_content")).toBeVisible()
  await expect(page.locator("#reading_content")).toHaveAttribute("data-mode", "reader")
  const reader = page.locator(".once-reader-host-frame").contentFrame()
  await expect(reader.locator("article").first()).toContainText("Once mobile reader fixture content")
  await page.screenshot({ path: "/tmp/once-mobile-reader-button.png" })
})

test("the address field clears in one tap and keeps focus", async ({ page }) => {
  await gotoMobileApp(page)
  await page.getByTestId("reading-menu").click()
  const address = page.getByTestId("reading-url-input")
  const clear = page.getByTestId("reading-url-clear")
  await expect(clear).toBeHidden()

  await address.tap()
  await expect(clear).toBeHidden()
  await address.pressSequentially("example.com/some/long path")
  await expect(clear).toBeVisible()

  // A tap that blurred the field first would restore the address instead.
  await clear.tap()
  await expect(address).toHaveValue("")
  await expect(address).toBeFocused()
  await expect(clear).toBeHidden()

  await address.pressSequentially("example.com")
  await expect(clear).toBeVisible()
  await address.blur()
  await expect(clear).toBeHidden()
})
