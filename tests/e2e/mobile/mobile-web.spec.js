const { test, expect } = require("@playwright/test")

test("mobile shell is responsive and hides unavailable capabilities", async ({ page }) => {
  await page.goto("./")
  await expect(page.locator("body")).toHaveAttribute("data-platform", "mobile")
  await expect(page.locator("body")).toHaveAttribute("data-once-ready", "true")
  await expect(page.getByTestId("app-version")).toContainText("dev")
  await expect(page.getByTestId("pick-source")).toBeHidden()
  await expect(page.getByTestId("settings-menu")).toBeVisible()
  await expect(page.getByTestId("stories-menu")).toBeVisible()
  expect(await page.locator("#left_panel").evaluate((element) => element.scrollWidth <= window.innerWidth)).toBe(true)
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
  await story.click({ delay: 700 })
  await page.getByTestId("sheet-story-reader").click()
  await expect(page.getByTestId("reader-close")).toBeVisible()
  const reader = page.locator(".once-reader-host-frame").contentFrame()
  await expect(reader.getByRole("heading", { name: "Fixture article" })).toBeVisible()
  await expect(reader.locator("body")).toHaveCSS("max-width", "700px")
  await expect(reader.locator(".toolbar")).toHaveCSS("position", "sticky")
  await expect(reader.locator("html")).toHaveAttribute("data-once-tts-installed", "true")
  await expect(reader.locator("article .tts-segment")).not.toHaveCount(0)
  await page.getByTestId("reader-close").click()

  await story.click({ delay: 700 })
  await page.getByTestId("sheet-story-read-state").click()
  await story.click({ delay: 700 })
  await page.getByTestId("sheet-story-read-state").click()
  await expect(story).toHaveClass(/skipped/)
  await page.waitForTimeout(500)
  await page.reload()
  await page.getByTestId("stories-menu").click()
  await page.getByTestId("reload-stories").click()
  await expect(page.getByTestId("story").filter({ hasText: "Fixture article" })).toHaveClass(/skipped/)
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
