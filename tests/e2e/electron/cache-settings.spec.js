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

// Seeded stories are fetched through the renderer fetch bridge, so these tests
// must leave it enabled.
const STORY_ENV = { env: { ONCE_ELECTRON_DISABLE_NETWORK_FETCH: "0" } }

function feedCounter() {
  const state = { fetches: 0 }
  state.onRequest = ({ phase, url }) => {
    if (phase === "request" && url.split("?")[0] === "/feed.rss") {
      state.fetches += 1
    }
  }
  return state
}

/**
 * Types into a settings field the way the harness seeds sources: assigning the
 * value and dispatching the event the control listens for. Electron text focus
 * can hang in the non-interactive Windows session CI uses.
 */
async function setFieldValue(locator, value) {
  await locator.evaluate((field, next) => {
    field.value = next
    field.dispatchEvent(new Event("change", { bubbles: true }))
  }, value)
}

test("the cache section reports each source and refetches one on demand", async () => {
  const counter = feedCounter()
  const server = await startPageServer({ onRequest: counter.onRequest })
  const { electronApp, userData, window } = await launchApp(STORY_ENV)
  try {
    await seedLocalSource(
      window,
      storyFixture.rssSourceLine(server.origin),
      storyFixture.storyUrls(server.origin).alpha
    )
    await openSettingsSection(window, "cache", "#cache_time_input")

    const row = window.locator(".cache_source_row").first()
    // The RSS collector ships no window of its own, so this row inherits the
    // global default and says so.
    await expect(row).toContainText("60 min (inherited)")
    await expect(row).toContainText("fetched")

    const cachedAt = counter.fetches
    await row.getByRole("button", { name: "Refetch now" }).click()
    await expect.poll(() => counter.fetches).toBe(cachedAt + 1)
  } finally {
    await closeApp(electronApp, userData)
    await server.close()
  }
})

test("clearing cached feeds sends the next reload back to the network", async () => {
  const counter = feedCounter()
  const server = await startPageServer({ onRequest: counter.onRequest })
  const { electronApp, userData, window } = await launchApp(STORY_ENV)
  try {
    await seedLocalSource(
      window,
      storyFixture.rssSourceLine(server.origin),
      storyFixture.storyUrls(server.origin).alpha
    )
    await openSettingsSection(window, "cache", "#cache_time_input")
    const row = window.locator(".cache_source_row").first()
    await expect(row).toContainText("fetched")

    const cachedAt = counter.fetches
    await window.getByTestId("clear-cached-feeds").click()
    await expect(row).toContainText("not cached")

    await showAllStories(window)
    await window.getByTestId("reload-stories").click()
    await expect.poll(() => counter.fetches).toBe(cachedAt + 1)
  } finally {
    await closeApp(electronApp, userData)
    await server.close()
  }
})

test("a per-collector window of zero refetches on every plain reload", async () => {
  const counter = feedCounter()
  const server = await startPageServer({ onRequest: counter.onRequest })
  const { electronApp, userData, window } = await launchApp(STORY_ENV)
  try {
    await seedLocalSource(
      window,
      storyFixture.rssSourceLine(server.origin),
      storyFixture.storyUrls(server.origin).alpha
    )
    await openSettingsSection(window, "cache", "#cache_time_input")

    // Without an override the freshly seeded body is served, so a plain reload
    // fetches nothing.
    const cachedAt = counter.fetches
    await showAllStories(window)
    await window.getByTestId("reload-stories").click()
    await expect(window.locator("#stories story-item.story").first()).toBeVisible()
    expect(counter.fetches).toBe(cachedAt)

    await openSettingsSection(window, "cache", "#cache_time_input")
    await setFieldValue(window.getByTestId("cache-timing-rss"), "0")
    await expect(window.locator(".cache_source_row").first())
      .toContainText("always refetch")

    await showAllStories(window)
    await window.getByTestId("reload-stories").click()
    await expect.poll(() => counter.fetches).toBe(cachedAt + 1)
  } finally {
    await closeApp(electronApp, userData)
    await server.close()
  }
})

test("a failed request serves the cached copy with a warning", async () => {
  let failing = false
  const server = await startPageServer({
    onRequest: ({ phase, url }) => {
      if (phase === "request" && url.split("?")[0] === "/feed.rss" && failing) {
        throw new Error("fixture feed is offline")
      }
    }
  })
  const { electronApp, userData, window } = await launchApp(STORY_ENV)
  try {
    const urls = storyFixture.storyUrls(server.origin)
    await seedLocalSource(window, storyFixture.rssSourceLine(server.origin), urls.alpha)

    // The body is cached; the feed then goes away and a forced reload must
    // still show stories, with the offline copy reported.
    failing = true
    await server.close()
    await showAllStories(window)
    await window.getByTestId("reload-stories").dblclick()

    await expect(window.locator("#status_bar_warnings .status_indicator_count"))
      .toHaveText("1", { timeout: 10_000 })
    await expect(
      window.locator(`#stories story-item[data-href="${urls.alpha}"]`)
    ).toBeVisible()

    // The bubbles time out on their own, so the log is where the warning can
    // be read without racing them.
    await openSettingsSection(window, "errors", "#error_log")
    await expect(window.locator("#error_log")).toContainText("Offline Copy")
  } finally {
    await closeApp(electronApp, userData)
    await server.close()
  }
})

test("the cache controls stay findable through settings search", async () => {
  const { electronApp, userData, window } = await launchApp()
  try {
    // Opening the section is what builds the rows; search then indexes them
    // like any other settings text, which is why they avoid
    // `.structured_settings` — that subtree is stripped from the index.
    await openSettingsSection(window, "cache", "#cache_time_input")
    await window.locator("#settings_section_back").click()

    const search = window.locator("#settings_search")
    await search.fill("Clear cached feeds")
    const result = window.locator('[data-settings-target="cache"]')
    await expect(result).toBeVisible()
    await expect(window.locator(".settings_section_row").filter({ visible: true }))
      .toHaveCount(1)
  } finally {
    await closeApp(electronApp, userData)
  }
})
