const { test, expect, chromium } = require("@playwright/test")
const fs = require("node:fs/promises")
const os = require("node:os")
const path = require("node:path")
const {
  HIDE_DELAY
} = require("../../../packages/ui-web/dist/HoverUrlIndicator")
const { startStoryFixture } = require("./local-source")
const storyFixture = require("../shared/story-fixture")

async function launchStoryExtension() {
  const extensionPath = path.resolve(
    __dirname,
    "../../../apps/chrome-extension/dist/release"
  )
  const userDataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "once-chrome-stories-")
  )
  const source = await startStoryFixture()
  const pageErrors = []
  const unexpectedRequests = []
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`
    ]
  })

  try {
    await context.route(/^https?:/, async (route) => {
      if (route.request().url().startsWith(source.origin)) {
        await route.continue()
        return
      }
      if (route.request().frame().url().includes("once-e2e=1")) {
        unexpectedRequests.push(route.request().url())
      }
      await route.abort()
    })

    let [worker] = context.serviceWorkers()
    if (!worker) worker = await context.waitForEvent("serviceworker")
    const extensionId = new URL(worker.url()).host
    const page = await context.newPage()
    page.on("pageerror", (error) => pageErrors.push(error.message))
    await page.goto(
      `chrome-extension://${extensionId}/static/sidepanel.html?once-e2e=1`
    )
    await expect(page.locator("body")).toHaveAttribute(
      "data-once-ready",
      "true"
    )
    expect(unexpectedRequests, "initial test-mode load must stay offline").toEqual(
      []
    )

    await openSettingsSection(page, "theme")
    await page.locator("#anim_checkbox").uncheck()
    await openSettingsSection(page, "sources")
    await page.getByTestId("sources").fill(source.source)
    await page.getByTestId("save-sources").click()
    await openStories(page)
    await expect(page.locator("#stories story-item").first()).toBeVisible()

    return {
      context,
      page,
      pageErrors,
      source,
      unexpectedRequests,
      userDataDir
    }
  } catch (error) {
    error.message +=
      `\nFixture requests: ${JSON.stringify(source.requests)}` +
      `\nUnexpected requests: ${JSON.stringify(unexpectedRequests)}` +
      `\nPage errors: ${JSON.stringify(pageErrors)}`
    await context.close()
    await source.close()
    await fs.rm(userDataDir, { recursive: true, force: true })
    throw error
  }
}

async function closeStoryExtension(harness) {
  await harness.context.close()
  await harness.source.close()
  await fs.rm(harness.userDataDir, { recursive: true, force: true })
}

function storyItem(page, href) {
  return page.locator(`#stories story-item[data-href="${href}"]`)
}

async function openStories(page) {
  await page.getByTestId("stories-menu").locator(":scope > .heading").click()
  await page.locator("#searchfield").fill("")
}

async function waitForOpenedPage(context, label, action) {
  const opened = context.waitForEvent("page", {
    timeout: 5_000
  }).catch(error => {
    throw new Error(`${label} did not open a new page within 5s`, { cause: error })
  })
  await action()
  const page = await opened
  await page.waitForLoadState("domcontentloaded", { timeout: 5_000 })
  return page
}

async function openSettingsSection(page, target) {
  await page.getByTestId("settings-menu").click()
  await page.locator(`[data-settings-target="${target}"]`).click()
}

async function saveRedirects(page, text) {
  await openSettingsSection(page, "redirects")
  await page.getByTestId("redirects").fill(text)
  await page.getByTestId("save-redirects").click()
  await openStories(page)
}

async function saveFilters(page, text) {
  await openSettingsSection(page, "filters")
  await page.getByTestId("filters").fill(text)
  await page.getByTestId("save-filters").click()
  await openStories(page)
}

// The swipe is detented: distance selects a stage, not a proportion of the
// row. Defaults are stage 1 from 56px and stage 2 from 200px, so these land
// mid-plateau rather than on a boundary.
const SWIPE_STAGE_DISTANCE = { 1: 110, 2: 260 }

async function swipeStory(page, story, direction, stage = 1) {
  await expect(story).toBeVisible()
  await story.scrollIntoViewIfNeeded()
  const box = await story.boundingBox()
  if (!box) throw new Error("Cannot swipe story without a bounding box")

  const startX = Math.round(box.x + box.width * 0.45)
  const y = Math.round(box.y + box.height / 2)
  const distance =
    SWIPE_STAGE_DISTANCE[stage] * (direction === "left" ? -1 : 1)
  await page.mouse.move(startX, y)
  await page.mouse.down()
  for (const fraction of [0.25, 0.5, 0.75, 1]) {
    await page.mouse.move(Math.round(startX + distance * fraction), y)
  }
  await page.mouse.up()
}

function expectCleanHarness(harness) {
  expect(harness.pageErrors).toEqual([])
  expect(
    harness.unexpectedRequests,
    "the extension test page must not access non-fixture origins"
  ).toEqual([])
}

test("opens story, comment, substory, and original links", async () => {
  const harness = await launchStoryExtension()
  const { context, page, source } = harness
  try {
    const alpha = storyItem(page, source.urls.alpha)
    const beta = storyItem(page, source.urls.beta)

    const alphaTitle = alpha.locator(storyFixture.SELECTORS.title)
    await alphaTitle.hover()
    const hoverUrl = page.locator("#hover_url")
    await expect(hoverUrl).toHaveText(source.urls.alpha)
    await expect(hoverUrl).toHaveClass(/\bvisible\b/)
    await page.locator("#searchfield").hover()
    await page.waitForTimeout(HIDE_DELAY / 2)
    await expect(hoverUrl).toHaveClass(/\bvisible\b/)
    await expect.poll(() => hoverUrl.getAttribute("class"), {
      timeout: HIDE_DELAY * 2
    }).not.toMatch(/\bvisible\b/)

    const alphaPage = await waitForOpenedPage(context, "alpha story link", () =>
      alphaTitle.click()
    )
    await expect(alphaPage).toHaveURL(source.urls.alpha)
    await expect(alpha).toHaveClass(/\bread\b/)
    await alphaPage.close()

    const betaPage = await waitForOpenedPage(context, "middle-clicked beta story link", () =>
      beta.locator(storyFixture.SELECTORS.title).click({ button: "middle" })
    )
    await expect(betaPage).toHaveURL(source.urls.beta)
    await expect(beta).toHaveClass(/\bread\b/)
    await betaPage.close()

    const comments = beta.locator(".info a.comment_url")
    await expect(comments).toHaveCount(2)
    const mainComments = await waitForOpenedPage(context, "beta comments link", () =>
      comments.nth(0).click()
    )
    await expect(mainComments).toHaveURL(source.urls.betaComments)
    await mainComments.close()
    const substoryComments = await waitForOpenedPage(context, "beta substory comments link", () =>
      comments.nth(1).click()
    )
    await expect(substoryComments).toHaveURL(source.urls.betaSubstoryComments)
    await substoryComments.close()

    await saveRedirects(page, source.redirectRule.line)
    const gamma = storyItem(page, source.redirectRule.original)
    await expect(gamma.locator(storyFixture.SELECTORS.title)).toHaveAttribute(
      "href",
      source.redirectRule.rewritten
    )
    const originalLink = gamma.locator(storyFixture.SELECTORS.og)
    await expect(originalLink).toBeVisible()
    const originalPage = await waitForOpenedPage(context, "original URL link", () =>
      originalLink.click()
    )
    await expect(originalPage).toHaveURL(source.redirectRule.original)
    expectCleanHarness(harness)
  } finally {
    await closeStoryExtension(harness)
  }
})

test("opens the reader and marks the story read", async () => {
  const harness = await launchStoryExtension()
  const { context, page, source } = harness
  try {
    const alpha = storyItem(page, source.urls.alpha)
    const readerPage = await waitForOpenedPage(context, "reader link", () =>
      alpha.locator(storyFixture.SELECTORS.outlineBtn).click()
    )
    await expect(readerPage).toHaveURL(/^data:text\/html/)
    await expect(readerPage).toHaveTitle(storyFixture.STORY_TITLES.alpha)
    await expect(readerPage.locator("a.reader-original")).toHaveAttribute(
      "href",
      source.urls.alpha
    )
    await expect(readerPage.locator("main > article")).toContainText(
      "The reader pipeline extracts long-form content"
    )
    await expect(alpha).toHaveClass(/\bread\b/)
    expectCleanHarness(harness)
  } finally {
    await closeStoryExtension(harness)
  }
})

test("swipes and persists skipped and starred state after reload", async () => {
  const harness = await launchStoryExtension()
  const { context, page, source } = harness
  try {
    const alpha = storyItem(page, source.urls.alpha)
    const beta = storyItem(page, source.urls.beta)
    const gamma = storyItem(page, source.urls.gamma)

    await swipeStory(page, gamma, "left")
    await expect(gamma).toHaveClass(/skipped/)

    const alphaPagePromise = context.waitForEvent("page")
    await swipeStory(page, alpha, "right")
    const alphaPage = await alphaPagePromise
    await expect(alphaPage).toHaveURL(source.urls.alpha)
    await expect(alpha).toHaveClass(/\bread\b/)
    await alphaPage.close()

    await beta.locator(storyFixture.SELECTORS.readBtn).click()
    await expect(beta).toHaveClass(/skipped/)
    await beta.locator(storyFixture.SELECTORS.readBtn).click()
    await expect(beta).not.toHaveClass(/\bread\b/)
    await expect(beta).not.toHaveClass(/skipped/)

    await alpha.locator(storyFixture.SELECTORS.starBtn).click()
    await expect(alpha).toHaveClass(/stared/)

    await page.reload()
    await expect(page.locator("body")).toHaveAttribute(
      "data-once-ready",
      "true"
    )
    await openStories(page)
    await page.getByTestId("reload-stories").click()
    await expect(storyItem(page, source.urls.gamma)).toHaveClass(/skipped/)
    await expect(storyItem(page, source.urls.alpha)).toHaveClass(/stared/)
    await storyItem(page, source.urls.alpha)
      .locator(storyFixture.SELECTORS.starBtn)
      .click()
    await expect(storyItem(page, source.urls.alpha)).not.toHaveClass(/stared/)
    expectCleanHarness(harness)
  } finally {
    await closeStoryExtension(harness)
  }
})

test("adds and removes a story filter", async () => {
  const harness = await launchStoryExtension()
  const { page, source } = harness
  try {
    await openSettingsSection(page, "theme")
    await page.locator("#theme_select").selectOption("dark")
    await openStories(page)

    const delta = storyItem(page, source.urls.delta)
    await delta.locator(storyFixture.SELECTORS.filterBtn).click()
    let input = delta.locator(`${storyFixture.SELECTORS.filterBtn} input`)
    await expect(input).toHaveValue("127.0.0.1")
    await input.fill(storyFixture.FILTER_TOKEN)
    await input.press("Enter")
    const dialog = page.getByTestId("confirm-dialog")
    await expect(dialog).toContainText(
      storyFixture.FILTER_TOKEN
    )
    await expect(dialog).toHaveCSS("background-color", "rgb(40, 42, 54)")
    await expect(dialog).toHaveCSS("color", "rgb(188, 194, 205)")
    await page.getByTestId("confirm-cancel").click()

    await openSettingsSection(page, "theme")
    await page.locator("#theme_select").selectOption("light")
    await openStories(page)
    await delta.locator(storyFixture.SELECTORS.filterBtn).click()
    input = delta.locator(`${storyFixture.SELECTORS.filterBtn} input`)
    await input.fill(storyFixture.FILTER_TOKEN)
    await input.press("Enter")
    await expect(dialog).toHaveCSS("background-color", "rgb(246, 246, 239)")
    await expect(dialog).toHaveCSS("color", "rgb(0, 0, 0)")
    await page.getByTestId("confirm-accept").click()
    await expect(delta).toHaveClass(/filtered/)
    await expect(delta).toBeHidden()

    await openSettingsSection(page, "filters")
    const filterArea = page.getByTestId("filters")
    await expect(filterArea).toHaveValue(
      new RegExp(storyFixture.FILTER_TOKEN)
    )
    const remaining = (await filterArea.inputValue())
      .split("\n")
      .filter((line) => line.trim() !== storyFixture.FILTER_TOKEN)
      .join("\n")
    await saveFilters(page, remaining)
    await expect(delta).not.toHaveClass(/filtered/)
    await expect(delta).toBeVisible()
    expectCleanHarness(harness)
  } finally {
    await closeStoryExtension(harness)
  }
})

test("tracks selected stories opened through original and rewritten URLs", async () => {
  const harness = await launchStoryExtension()
  const { context, page, source } = harness
  try {
    await saveRedirects(page, source.redirectRule.line)
    const selected = page.locator(storyFixture.SELECTORS.selected)
    const alpha = storyItem(page, source.urls.alpha)
    const alphaPage = await waitForOpenedPage(context, "selected alpha story link", () =>
      alpha.locator(storyFixture.SELECTORS.title).click()
    )
    await expect(alphaPage).toHaveURL(source.urls.alpha)
    await expect
      .poll(() => selected.getAttribute("data-href"))
      .toBe(source.urls.alpha)

    const gamma = storyItem(page, source.redirectRule.original)
    const gammaPage = await waitForOpenedPage(context, "selected rewritten story link", () =>
      gamma.locator(storyFixture.SELECTORS.title).click()
    )
    await expect(gammaPage).toHaveURL(source.redirectRule.rewritten)
    await expect
      .poll(() => selected.getAttribute("data-href"))
      .toBe(source.redirectRule.original)
    expectCleanHarness(harness)
  } finally {
    await closeStoryExtension(harness)
  }
})
