const { test, expect } = require("@playwright/test")
const {
  HIDE_DELAY
} = require("../../../packages/ui-web/dist/HoverUrlIndicator")
const {
  closeApp,
  launchApp,
  openPanel,
  openSettingsSection,
  saveFilters,
  saveRedirects,
  seedLocalSource,
  showAllStories,
  startPageServer
} = require("./electron-harness")
const storyFixture = require("../shared/story-fixture")

// The story specs exercise real story fetches against the local fixture
// server, so the renderer fetch bridge must stay enabled.
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

function storyItem(window, href) {
  return window.locator(`#stories story-item[data-href="${href}"]`)
}

async function storyRevision(story) {
  return story.evaluate((element) => element.story?._rev || null)
}

async function clickAndWaitForPersistence(story, buttonSelector) {
  await expect
    .poll(() => storyRevision(story), {
      message: "the fixture story must be persisted before it is mutated"
    })
    .not.toBeNull()
  const previousRevision = await storyRevision(story)
  await story.locator(buttonSelector).click()
  await expect
    .poll(() => storyRevision(story), {
      message: `clicking ${buttonSelector} must finish persisting the story`
    })
    .not.toBe(previousRevision)
}

async function getTabs(window) {
  return window.evaluate(() => window.onceElectron.tabs.getAll())
}

// The swipe is detented: distance selects a stage, not a proportion of the
// row. Defaults are stage 1 from 56px and stage 2 from 200px, so these land
// mid-plateau rather than on a boundary.
const SWIPE_STAGE_DISTANCE = { 1: 110, 2: 260 }

// Several moves rather than one jump, so the drag passes through the detents
// the way a real one does. The origin is the press, so the full distance counts.
async function swipeStory(window, story, direction, stage = 1) {
  await expect(story).toBeVisible()
  await story.scrollIntoViewIfNeeded()

  const box = await story.boundingBox()
  if (!box) {
    throw new Error("Cannot swipe story: it has no visible bounding box")
  }

  // Fractional positions on purpose: real touch coordinates (Android
  // especially) are sub-pixel, and the drag maths must handle those too.
  const startX = box.x + box.width * 0.45
  const y = box.y + box.height / 2
  const distance =
    SWIPE_STAGE_DISTANCE[stage] * (direction === "left" ? -1 : 1)

  await window.mouse.move(startX, y)
  await window.mouse.down()

  for (const fraction of [0.25, 0.5, 0.75, 1]) {
    await window.mouse.move(startX + distance * fraction, y)
  }

  await window.mouse.up()
}

test("opens stories via title click, middle click, and comment links", async () => {
  const { electronApp, userData, window } = await launchApp(STORY_ENV)
  try {
    await seedLocalSource(window, storyFixture.sourceLine(origin), urls.alpha)
    const address = window.locator("#urlfield")
    const alpha = storyItem(window, urls.alpha)
    const beta = storyItem(window, urls.beta)

    await alpha.locator("a.title").hover()
    const hoverUrl = window.locator("#hover_url")
    await expect(hoverUrl).toHaveText(urls.alpha)
    await expect(hoverUrl).toHaveClass(/\bvisible\b/)
    await expect(window.locator("#status_bar_text")).not.toHaveText(urls.alpha)

    await window.locator("#searchfield").hover()
    await window.waitForTimeout(HIDE_DELAY / 2)
    await expect(hoverUrl).toHaveClass(/\bvisible\b/)
    await expect.poll(() => hoverUrl.getAttribute("class"), {
      timeout: HIDE_DELAY * 2
    }).not.toMatch(/\bvisible\b/)

    await alpha.locator("a.title").hover()
    await expect(hoverUrl).toHaveClass(/\bvisible\b/)

    await alpha.locator("a.title").click()
    await expect(address).toHaveValue(urls.alpha)
    await expect(alpha).toHaveClass(/\bread\b/)
    await expect(alpha).not.toHaveClass(/skipped/)

    await beta.locator("a.title").click({ button: "middle" })
    await expect.poll(() => getTabs(window)).toMatchObject([
      { url: urls.alpha, active: true },
      { url: urls.beta, active: false }
    ])
    await expect(address).toHaveValue(urls.alpha)
    await expect(beta).toHaveClass(/\bread\b/)

    const commentLinks = beta.locator(".info a.comment_url")
    await expect(commentLinks).toHaveCount(2)
    await commentLinks.nth(0).click()
    await expect(address).toHaveValue(urls.betaComments)
    await commentLinks.nth(1).click()
    await expect(address).toHaveValue(urls.betaSubstoryComments)
  } finally {
    await closeApp(electronApp, userData)
  }
})

test("stacks, dismisses, restores, and opens source issues through the error log", async () => {
  const { electronApp, userData, window } = await launchApp(STORY_ENV)
  try {
    const warningOne = "https://invalid-one.example/unknown"
    const warningTwo = "https://invalid-two.example/unknown"
    const failingSource = `${origin}/failure.rss`
    const sourceLines = [warningOne, warningTwo, failingSource].join("\n")

    const animation = await openSettingsSection(
      window,
      "theme",
      "#anim_checkbox"
    )
    await animation.uncheck()
    const sources = await openSettingsSection(
      window,
      "sources",
      '[data-testid="sources"]'
    )
    await sources.evaluate((textarea, value) => {
      textarea.value = value
    }, sourceLines)
    await window.getByTestId("save-sources").evaluate((button) => button.click())

    const warnings = window.locator("#status_bar_warnings")
    const errors = window.locator("#status_bar_errors")
    await expect(warnings.locator(".status_indicator_count")).toHaveText("2")
    await expect(errors.locator(".status_indicator_count")).toHaveText("1")
    const dock = window.locator("#status_dock")
    await expect(dock).toHaveCSS("border-right-width", "0px")
    await expect(dock).toHaveCSS("border-radius", "14px 0px 0px 14px")
    await expect(window.locator(".status_issue_bubble.warning")).toHaveCount(2)
    await expect(window.locator(".status_issue_bubble.error")).toHaveCount(1)

    await window.waitForTimeout(5_200)
    await expect(window.locator(".status_issue_bubble.warning")).toHaveCount(0)
    await expect(window.locator(".status_issue_bubble.error")).toHaveCount(1)
    await warnings.click()
    await expect(window.locator(".status_issue_bubble.warning")).toHaveCount(2)

    await window
      .locator(".status_issue_bubble.warning .status_issue_close")
      .first()
      .click()
    await expect(window.locator(".status_issue_bubble.warning")).toHaveCount(1)
    await warnings.click()
    await expect(window.locator(".status_issue_bubble.warning")).toHaveCount(0)
    await warnings.click()
    await expect(window.locator(".status_issue_bubble.warning")).toHaveCount(2)

    await window.locator(".status_issue_bubble.error .status_issue_close").click()
    await expect(window.locator(".status_issue_bubble.error")).toHaveCount(0)
    await errors.click()
    const errorBubble = window.locator(".status_issue_bubble.error")
    await expect(errorBubble).toHaveCount(1)

    await openSettingsSection(
      window,
      "sources",
      '[data-testid="sources-structured-list"]'
    )
    const failingSourceButton = window.locator(
      `[data-source-value="${failingSource}"]`
    )
    await failingSourceButton.click()
    await expect(window.getByTestId("structured-item-form")).toBeVisible()

    await errorBubble.locator(".status_issue_content").click()
    await expect(window.locator("#left_panel")).toHaveAttribute(
      "active_panel",
      "settings"
    )
    await expect(window.locator("#status_dock")).toBeVisible()
    const logEntry = window
      .locator("#error_log .error_log_entry")
      .filter({ hasText: failingSource })
    await expect(logEntry).toBeVisible()
    await expect(logEntry).toHaveAttribute("open", "")
    await logEntry.locator(".error_log_show_source").click()
    await expect(window.getByTestId("structured-item-form")).toBeHidden()
    await expect(failingSourceButton).toBeVisible()
    await expect(failingSourceButton).toBeFocused()
    await expect(failingSourceButton).toHaveClass(/\bstructured_row_target\b/)
  } finally {
    await closeApp(electronApp, userData)
  }
})

test("outline button opens the story in reader mode", async () => {
  const { electronApp, userData, window } = await launchApp(STORY_ENV)
  try {
    await seedLocalSource(window, storyFixture.sourceLine(origin), urls.alpha)
    const alpha = storyItem(window, urls.alpha)

    await alpha.locator(".outline_btn").click()
    await expect.poll(() => getTabs(window)).toMatchObject([
      {
        url: expect.stringMatching(/^once-reader:\/\/.*\/story\/alpha$/),
        active: true,
        loadError: null
      }
    ])
    await expect(window.locator(".electron-tab-title")).toContainText(
      storyFixture.STORY_TITLES.alpha
    )
    await expect(alpha).toHaveClass(/\bread\b/)
  } finally {
    await closeApp(electronApp, userData)
  }
})

test("swipe right opens a story", async () => {
  const { electronApp, userData, window } = await launchApp(STORY_ENV)
  try {
    await seedLocalSource(window, storyFixture.sourceLine(origin), urls.alpha)
    const address = window.locator("#urlfield")
    const beta = storyItem(window, urls.beta)

    await swipeStory(window, beta, "right")
    await expect(address).toHaveValue(urls.beta)
    await expect(beta).toHaveClass(/\bread\b/)
    await expect(beta).not.toHaveClass(/skipped/)
  } finally {
    await closeApp(electronApp, userData)
  }
})

test("swipe left skips a story without navigating", async () => {
  const { electronApp, userData, window } = await launchApp(STORY_ENV)
  try {
    await seedLocalSource(window, storyFixture.sourceLine(origin), urls.alpha)
    const address = window.locator("#urlfield")
    const gamma = storyItem(window, urls.gamma)
    const initialAddress = await address.inputValue()

    await swipeStory(window, gamma, "left")
    await expect(gamma).toHaveClass(/skipped/)
    await expect(address).toHaveValue(initialAddress)
  } finally {
    await closeApp(electronApp, userData)
  }
})

test("a full swipe left keeps the filter editor open after release", async () => {
  const { electronApp, userData, window } = await launchApp(STORY_ENV)
  try {
    await seedLocalSource(window, storyFixture.sourceLine(origin), urls.alpha)
    const delta = storyItem(window, urls.delta)

    await swipeStory(window, delta, "left", 2)
    await expect(delta.locator(".filter_btn input")).toHaveValue("127.0.0.1")
  } finally {
    await closeApp(electronApp, userData)
  }
})

test("skip and star toggles persist across an app relaunch", async () => {
  // A healthy two-launch cycle completes in a few seconds. Treat anything
  // materially longer as a hung renderer instead of consuming the suite's
  // broader timeout budget.
  test.setTimeout(10_000)
  const first = await launchApp(STORY_ENV)
  const userData = first.userData
  let electronApp = first.electronApp
  try {
    const window = first.window
    await seedLocalSource(window, storyFixture.sourceLine(origin), urls.alpha)
    const alpha = storyItem(window, urls.alpha)
    const beta = storyItem(window, urls.beta)
    const gamma = storyItem(window, urls.gamma)

    await clickAndWaitForPersistence(alpha, ".read_btn")
    await expect(alpha).toHaveClass(/skipped/)
    await expect(alpha.locator(".read_btn")).toHaveAttribute("title", "unskip")
    await clickAndWaitForPersistence(alpha, ".read_btn")
    await expect(alpha).not.toHaveClass(/\bread\b/)
    await expect(alpha).not.toHaveClass(/skipped/)

    await clickAndWaitForPersistence(beta, ".read_btn")
    await expect(beta).toHaveClass(/skipped/)

    await clickAndWaitForPersistence(gamma, ".star_btn")
    await expect(gamma).toHaveClass(/stared/)
    await expect(gamma.locator(".star_btn")).toHaveAttribute(
      "title",
      "remove bookmark"
    )

    await closeApp(electronApp, userData, { keepUserData: true })
    const second = await launchApp({ ...STORY_ENV, userData })
    electronApp = second.electronApp
    const window2 = second.window

    await showAllStories(window2)
    await window2.getByTestId("reload-stories").click()
    const beta2 = storyItem(window2, urls.beta)
    const gamma2 = storyItem(window2, urls.gamma)
    await expect(beta2).toHaveClass(/skipped/)
    await expect(gamma2).toHaveClass(/stared/)

    await clickAndWaitForPersistence(gamma2, ".star_btn")
    await expect(gamma2).not.toHaveClass(/stared/)
  } finally {
    await closeApp(electronApp, userData)
  }
})

test("filters a story from the story list and removes the filter again", async () => {
  const { electronApp, userData, window } = await launchApp(STORY_ENV)
  try {
    await seedLocalSource(window, storyFixture.sourceLine(origin), urls.alpha)
    const delta = storyItem(window, urls.delta)

    await delta.locator(".filter_btn").click()
    const filterInput = delta.locator(".filter_btn input")
    await expect(filterInput).toHaveValue("127.0.0.1")
    await filterInput.fill(storyFixture.FILTER_TOKEN)
    await filterInput.press("Enter")
    await expect(window.getByTestId("confirm-dialog")).toContainText(
      storyFixture.FILTER_TOKEN
    )
    const dialogPosition = await window.evaluate(() => {
      const panel = document.querySelector("#stories_panel")
      const dialog = document.querySelector('[data-testid="confirm-dialog"]')
      if (!panel || !dialog) throw new Error("Filter dialog is not mounted")
      const panelRect = panel.getBoundingClientRect()
      const dialogRect = dialog.getBoundingClientRect()
      return {
        centerDeltaX:
          dialogRect.left + dialogRect.width / 2 -
          (panelRect.left + panelRect.width / 2),
        centerDeltaY:
          dialogRect.top + dialogRect.height / 2 -
          (panelRect.top + panelRect.height / 2),
        contained:
          dialogRect.left >= panelRect.left &&
          dialogRect.right <= panelRect.right &&
          dialogRect.top >= panelRect.top &&
          dialogRect.bottom <= panelRect.bottom
      }
    })
    expect(Math.abs(dialogPosition.centerDeltaX)).toBeLessThanOrEqual(1)
    expect(Math.abs(dialogPosition.centerDeltaY)).toBeLessThanOrEqual(1)
    expect(dialogPosition.contained).toBe(true)
    await window.getByTestId("confirm-accept").click()
    await expect(delta).toHaveClass(/filtered/)
    await expect(delta).toBeHidden()

    await openPanel(window, "settings")
    const filtersArea = window.getByTestId("filters")
    await expect(filtersArea).toHaveValue(
      new RegExp(storyFixture.FILTER_TOKEN)
    )

    await openPanel(window, "stories")
    await window.locator("#searchfield").fill("[filtered]")
    await expect(window.locator("#stories")).toHaveClass(/show_filtered/)
    await expect(delta).toBeVisible()
    await window.locator("#searchfield").fill("")
    await expect(delta).toBeHidden()

    const remaining = (await filtersArea.inputValue())
      .split("\n")
      .filter((line) => line.trim() !== storyFixture.FILTER_TOKEN)
      .join("\n")
    await saveFilters(window, remaining)
    await expect(delta).not.toHaveClass(/filtered/)
    await expect(delta).toBeVisible()
  } finally {
    await closeApp(electronApp, userData)
  }
})

test("selects the story for rewritten URLs opened from the list or the URL bar", async () => {
  const { electronApp, userData, window } = await launchApp(STORY_ENV)
  try {
    await seedLocalSource(window, storyFixture.sourceLine(origin), urls.alpha)
    const rule = storyFixture.redirectRule(origin)
    await saveRedirects(window, rule.line)

    const address = window.locator("#urlfield")
    const gamma = storyItem(window, rule.original)
    await expect(gamma.locator("a.title")).toHaveAttribute(
      "href",
      rule.rewritten
    )
    await expect(gamma.locator("a.og_href")).toBeVisible()

    const selected = window.locator("#selected_container story-item.selected")

    await gamma.locator("a.title").click()
    await expect(address).toHaveValue(rule.rewritten)
    await expect(selected).toHaveAttribute("data-href", rule.original)
    await expect(gamma).toHaveClass(/\bread\b/)

    await address.fill(urls.alpha)
    await address.press("Enter")
    await expect(selected).toHaveAttribute("data-href", urls.alpha)

    // Navigating straight to the rewritten URL exercises the pure
    // rewritten -> original reverse lookup (778a258).
    await address.fill(rule.rewritten)
    await address.press("Enter")
    await expect(selected).toHaveAttribute("data-href", rule.original)
  } finally {
    await closeApp(electronApp, userData)
  }
})
