const { test, expect } = require("@playwright/test")
const {
  gotoMobileApp,
  reloadMobileApp,
  testServerUrl,
  triggerMobileBack
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

test("tapping the address opens the editor, which clears in one tap and keeps focus", async ({ page }) => {
  await gotoMobileApp(page)
  await page.getByTestId("reading-menu").click()
  const address = page.getByTestId("reading-url-input")
  const editor = page.getByTestId("address-editor-input")
  const clear = page.getByTestId("address-editor-clear")

  await address.tap()
  await expect(editor).toBeFocused()
  await expect(clear).toBeHidden()
  await editor.pressSequentially("example.com/some/long path")
  await expect(clear).toBeVisible()

  // A tap that blurred the field first would move the caret or close the keyboard.
  await clear.tap()
  await expect(editor).toHaveValue("")
  await expect(editor).toBeFocused()
  await expect(clear).toBeHidden()

  await editor.pressSequentially("example.com")
  expect(await triggerMobileBack(page)).toBe(true)
  await expect(editor).toBeHidden()
  await expect(address).toHaveValue("")
})

test("the address editor's quick edits work on one field", async ({ page }) => {
  await gotoMobileApp(page)
  await page.getByTestId("reading-menu").click()
  const url = "https://example.test/articles/42/?page=2&utm_source=rss#comments"
  await page.getByTestId("reading-url-input").fill(url)
  await page.getByTestId("reading-url-input").press("Enter")
  await page.getByTestId("reading-url-input").tap()
  const editor = page.getByTestId("address-editor-input")
  const dialog = page.getByTestId("address-editor")
  await expect(editor).toHaveValue(url)
  await expect(dialog.getByText("Paste and go")).toBeVisible()

  await dialog.getByRole("button", { name: "Remove 1 tracker" }).tap()
  await expect(editor).toHaveValue("https://example.test/articles/42/?page=2#comments")
  await expect(dialog.getByText("Paste and go")).toBeHidden()
  await dialog.getByRole("button", { name: "Explode" }).tap()
  await expect(editor).toHaveValue("https://\nexample.test\n/articles\n/42/\n?page=2\n#comments")
  await dialog.getByRole("button", { name: "Remove ?page=2#comments" }).tap()
  await expect(editor).toHaveValue("https://\nexample.test\n/articles\n/42/")
  await dialog.getByRole("button", { name: "Remove /42" }).tap()
  await dialog.getByRole("button", { name: "Collapse" }).tap()
  await expect(editor).toHaveValue("https://example.test/articles/")
  await editor.press("Enter")
  await expect(dialog).toBeHidden()
  await expect(page.getByTestId("reading-url-input")).toHaveValue("https://example.test/articles/")
})

test("a part swiped left in the exploded address goes, and Undo brings it back", async ({ page }) => {
  await gotoMobileApp(page)
  await page.getByTestId("reading-menu").click()
  const url = "https://example.test/articles/42/?page=2&sort=new"
  await page.getByTestId("reading-url-input").fill(url)
  await page.getByTestId("reading-url-input").press("Enter")
  await page.getByTestId("reading-url-input").tap()
  const editor = page.getByTestId("address-editor-input")
  const dialog = page.getByTestId("address-editor")
  await dialog.getByRole("button", { name: "Explode" }).tap()
  const touch = await page.context().newCDPSession(page)
  const swipe = async (line, distance) => {
    const box = await dialog.locator(`[data-line="${line}"]`).boundingBox()
    const y = box.y + box.height / 2
    const x = box.x + box.width - 4
    await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] })
    for (let step = 1; step <= 8; step += 1) {
      await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x - distance * step / 8, y }] })
    }
    await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
  }

  const exploded = "https://\nexample.test\n/articles\n/42/\n?page=2\n&sort=new"
  await expect(editor).toHaveValue(exploded)
  // The threshold is a share of the room left of the finger: a swipe from the
  // end of the short "/42/" near the edge needs less than one from the end of
  // a longer parameter; 30px goes short of the long one's, 20px of both.
  await swipe(5, 30)
  await swipe(3, 20)
  await expect(editor).toHaveValue(exploded)
  await swipe(3, 30)
  await expect(editor).toHaveValue("https://\nexample.test\n/articles\n?page=2\n&sort=new")
  await dialog.getByRole("status").getByRole("button", { name: "Undo" }).tap()
  await expect(editor).toHaveValue(exploded)
  // The first parameter goes and the next one takes its "?".
  await swipe(4, 200)
  await expect(editor).toHaveValue("https://\nexample.test\n/articles\n/42/\n?sort=new")
  await expect(dialog.getByRole("status")).toContainText("Removed ?page=2")
  // The scheme and the site go like any other part.
  await swipe(0, 200)
  await expect(editor).toHaveValue("example.test\n/articles\n/42/\n?sort=new")
  await swipe(0, 200)
  await expect(editor).toHaveValue("/articles\n/42/\n?sort=new")
  await dialog.getByRole("status").getByRole("button", { name: "Undo" }).tap()
  await expect(editor).toHaveValue("example.test\n/articles\n/42/\n?sort=new")
  // The toolbar's Undo keeps stepping back, one change at a time.
  const undo = dialog.getByRole("toolbar").getByRole("button", { name: "Undo" })
  await undo.tap()
  await expect(editor).toHaveValue("https://\nexample.test\n/articles\n/42/\n?sort=new")
  await undo.tap()
  await expect(editor).toHaveValue(exploded)
  await expect(undo).toBeHidden()
})

test("Undo in the address editor steps back through every change, typing included", async ({ page }) => {
  await gotoMobileApp(page)
  await page.getByTestId("reading-menu").click()
  const url = "https://example.test/articles/42/?utm_source=rss"
  await page.getByTestId("reading-url-input").fill(url)
  await page.getByTestId("reading-url-input").press("Enter")
  await page.getByTestId("reading-url-input").tap()
  const editor = page.getByTestId("address-editor-input")
  const dialog = page.getByTestId("address-editor")
  const undo = dialog.getByRole("toolbar").getByRole("button", { name: "Undo" })
  await expect(undo).toBeHidden()

  await dialog.getByRole("button", { name: "Remove 1 tracker" }).tap()
  await dialog.getByRole("button", { name: "Remove /42" }).tap()
  await editor.press("End")
  await editor.pressSequentially("news")
  await expect(editor).toHaveValue("https://example.test/articles/news")
  await dialog.getByRole("button", { name: "Clear address" }).tap()
  await expect(editor).toHaveValue("")

  await undo.tap()
  await expect(editor).toHaveValue("https://example.test/articles/news")
  // One burst of typing is one step.
  await undo.tap()
  await expect(editor).toHaveValue("https://example.test/articles/")
  await undo.tap()
  await expect(editor).toHaveValue("https://example.test/articles/42/")
  await undo.tap()
  await expect(editor).toHaveValue(url)
  await expect(undo).toBeHidden()
})
