const { test, expect } = require("@playwright/test")

async function openStorySheet(page, story) {
  await story.click({ delay: 700 })
  await expect(page.getByTestId("sheet-cancel")).toBeVisible()
  // The app suppresses the synthetic release click from a long-press for up
  // to 250ms. Do not let the harness's next intentional tap get swallowed.
  await page.waitForTimeout(300)
}

test("mobile shell is responsive and hides unavailable capabilities", async ({ page }) => {
  await page.goto("./")
  await expect(page.locator("body")).toHaveAttribute("data-platform", "mobile")
  await expect(page.locator("body")).toHaveAttribute("data-once-ready", "true")
  await expect(page.getByTestId("app-version")).toContainText("dev")
  await expect(page.getByTestId("pick-source")).toBeHidden()
  await expect(page.getByTestId("settings-menu")).toBeVisible()
  await expect(page.getByTestId("stories-menu")).toBeVisible()
  expect(await page.locator("#left_panel").evaluate((element) => element.scrollWidth <= window.innerWidth)).toBe(true)
  expect(await page.locator("#stories").evaluate((stories) => {
    const finalStory = document.createElement("article")
    finalStory.style.cssText = "display:block;flex:0 0 1200px;height:1200px"
    stories.replaceChildren(finalStory)
    stories.scrollTop = stories.scrollHeight
    const menu = document.querySelector("#menu")
    return finalStory.getBoundingClientRect().bottom <=
      menu.getBoundingClientRect().top
  })).toBe(true)
})

test("mobile refresh controls stay separated and theme-aware", async ({ page }) => {
  await page.goto("./")

  const gap = await page.locator("#searchfield").evaluate((search) => {
    const reload = document.querySelector("#reload_stories_btn")
    return reload.getBoundingClientRect().left - search.getBoundingClientRect().right
  })
  expect(gap).toBeGreaterThanOrEqual(12)

  await page.locator("#stories").evaluate((stories) => {
    const touch = new Touch({
      identifier: 1,
      target: stories,
      clientX: 200,
      clientY: 100
    })
    stories.dispatchEvent(new TouchEvent("touchstart", {
      bubbles: true,
      cancelable: true,
      touches: [touch]
    }))
    const moved = new Touch({
      identifier: 1,
      target: stories,
      clientX: 200,
      clientY: 150
    })
    stories.dispatchEvent(new TouchEvent("touchmove", {
      bubbles: true,
      cancelable: true,
      touches: [moved]
    }))
  })

  for (const theme of ["light", "dark"]) {
    await page.locator("body").evaluate((body, value) => {
      body.dataset.theme = value
    }, theme)
    const colors = await page.locator(".ptr-surface").evaluate((surface) => {
      const body = document.body
      const icon = surface.querySelector(".ptr-icon")
      const reload = document.querySelector("#reload_stories_btn")
      return {
        surface: getComputedStyle(surface).backgroundColor,
        body: getComputedStyle(body).backgroundColor,
        icon: getComputedStyle(icon).backgroundColor,
        reload: getComputedStyle(reload).color
      }
    })
    expect(colors.surface).not.toBe(colors.body)
    expect(colors.icon).toBe(colors.reload)
  }
})

test("mobile settings persist without contacting external sources", async ({ page }) => {
  await page.goto("./")
  await page.getByTestId("settings-menu").click()
  await page.getByTestId("sources").fill("http://127.0.0.1:3211/fixtures/feed.rss")
  await page.getByTestId("save-sources").click()
  await page.waitForTimeout(500)
  await page.reload()
  await page.getByTestId("settings-menu").click()
  await expect(page.getByTestId("sources")).toHaveValue(/\/fixtures\/feed\.rss/)
})

test("stories persist offline and open in the in-app reader", async ({ page }) => {
  await page.goto("./")
  await page.getByTestId("settings-menu").click()
  await page.getByTestId("sources").fill("http://127.0.0.1:3211/fixtures/feed.rss")
  await page.getByTestId("save-sources").click()
  await page.waitForTimeout(500)
  await page.reload()
  await page.getByTestId("settings-menu").click()
  await expect(page.getByTestId("sources")).toHaveValue(/\/fixtures\/feed\.rss/)
  await page.getByTestId("stories-menu").click()
  await page.getByTestId("reload-stories").click()

  const story = page.getByTestId("story").filter({ hasText: "Fixture article" })
  await expect(story).toBeVisible()
  // story actions live in a long-press sheet on mobile
  await openStorySheet(page, story)
  await page.getByTestId("sheet-story-reader").click()
  await expect(page.getByTestId("reader-close")).toBeVisible()
  const reader = page.locator(".once-reader-host-frame").contentFrame()
  await expect(reader.getByRole("heading", { name: "Fixture article" })).toBeVisible()
  await expect(reader.locator("body")).toHaveCSS("max-width", "700px")
  await expect(reader.locator(".toolbar")).toHaveCSS("position", "sticky")
  await expect(reader.locator("html")).toHaveAttribute("data-once-tts-installed", "true")
  await expect(reader.locator("article .tts-segment")).not.toHaveCount(0)
  await page.getByTestId("reader-close").click()
  // closing must unload the frame so pagehide stops any running speech
  await expect(reader.getByRole("heading", { name: "Fixture article" })).toHaveCount(0)

  await openStorySheet(page, story)
  await page.getByTestId("sheet-story-read-state").click()
  await openStorySheet(page, story)
  await page.getByTestId("sheet-story-read-state").click()
  await expect(story).toHaveClass(/skipped/)
  await page.waitForTimeout(500)
  await page.reload()
  await page.getByTestId("stories-menu").click()
  await page.getByTestId("reload-stories").click()
  await expect(page.getByTestId("story").filter({ hasText: "Fixture article" })).toHaveClass(/skipped/)
})

test("reader TTS bridges through the host when the frame lacks speech synthesis", async ({ page }) => {
  // Simulate the Android WebView reader frame, which has no Web Speech API.
  await page.addInitScript(() => {
    if (window.parent !== window) {
      Object.defineProperty(window, "speechSynthesis", { configurable: true, value: undefined })
      Object.defineProperty(window, "SpeechSynthesisUtterance", { configurable: true, value: undefined })
    }
  })
  await page.goto("./")
  await page.getByTestId("settings-menu").click()
  await page.getByTestId("sources").fill("http://127.0.0.1:3211/fixtures/feed.rss")
  await page.getByTestId("save-sources").click()
  await page.waitForTimeout(500)
  await page.reload()
  await page.getByTestId("stories-menu").click()
  await page.getByTestId("reload-stories").click()

  const story = page.getByTestId("story").filter({ hasText: "Fixture article" })
  await expect(story).toBeVisible()
  await openStorySheet(page, story)
  await page.getByTestId("sheet-story-reader").click()
  await expect(page.getByTestId("reader-close")).toBeVisible()
  const reader = page.locator(".once-reader-host-frame").contentFrame()
  await expect(reader.locator("html")).toHaveAttribute("data-once-tts-installed", "true")
  // the polyfill bridges to the host, so TTS stays available instead of disabled
  await expect(reader.getByTestId("tts-unavailable")).toHaveCount(0)
  await expect(reader.locator("[data-tts-play]")).toBeEnabled()
  await expect(reader.locator("article .tts-segment")).not.toHaveCount(0)
})

test("theme and phone navigation survive orientation changes", async ({ page }) => {
  await page.goto("./")
  await page.getByTestId("settings-menu").click()
  await page.getByTestId("theme").selectOption("light")
  await expect(page.locator("body")).toHaveAttribute("data-theme", "light")
  await page.setViewportSize({ width: 915, height: 412 })
  await expect(page.getByTestId("stories-menu")).toBeVisible()
  await expect(page.locator("#left_panel")).toHaveCSS("min-width", "0px")
})

test("authenticated PouchDB sync pulls and pushes deterministic settings", async ({ page, request }) => {
  const database = "web_sync"
  await request.post(`http://127.0.0.1:3211/test/databases/${database}/reset`, {
    data: { docs: [{ _id: "theme", list: "light" }] }
  })
  await page.goto("./")
  await page.getByTestId("settings-menu").click()
  await page.getByTestId("sync-url").fill(
    `http://once-test:once-test@127.0.0.1:3211/db/${database}`
  )
  await page.getByTestId("save-sync").click()
  await expect(page.locator("body")).toHaveAttribute("data-theme", "light", { timeout: 15_000 })

  await page.getByTestId("theme").selectOption("dark")
  await expect.poll(async () => {
    const response = await request.get(`http://127.0.0.1:3211/db/${database}/theme`, {
      headers: { Authorization: `Basic ${Buffer.from("once-test:once-test").toString("base64")}` }
    })
    return response.ok() ? (await response.json()).list : "pending"
  }, { timeout: 15_000 }).toBe("dark")

  await page.reload()
  await expect(page.locator("body")).toHaveAttribute("data-theme", "dark")
})
