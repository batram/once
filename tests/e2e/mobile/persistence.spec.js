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
const { openStoryMenu } = require("./helpers/stories")

test("mobile settings persist without contacting external sources", async ({ page }) => {
  await gotoMobileApp(page)
  await openSettingsSection(page, "sources")
  await page.getByTestId("sources").fill(await testServerUrl(page, "/fixtures/feed.rss"))
  await saveSourcesAndWait(page)
  await reloadMobileApp(page)
  await openSettingsSection(page, "sources")
  await expect(page.getByTestId("sources")).toHaveValue(/\/fixtures\/feed\.rss/)
})

test("stories persist offline and open in the in-app reader", async ({ page }) => {
  await gotoMobileApp(page)
  await openSettingsSection(page, "sources")
  await page.getByTestId("sources").fill(await testServerUrl(page, "/fixtures/feed.rss"))
  await saveSourcesAndWait(page)
  await reloadMobileApp(page)
  await openSettingsSection(page, "sources")
  await expect(page.getByTestId("sources")).toHaveValue(/\/fixtures\/feed\.rss/)
  await page.getByTestId("stories-menu").click()
  await page.getByTestId("reload-stories").click()

  const story = page.getByTestId("story").filter({ hasText: "Fixture article" })
  await expect(story).toBeVisible()
  // story actions live in the anchored ⋮ menu on mobile
  await openStoryMenu(page, story)
  await page.getByTestId("story-menu-open-reader").click()
  await expect(page.locator("#reading_content")).toHaveAttribute("data-mode", "reader")
  await expect(page.getByTestId("reading-empty")).toBeHidden()
  const reader = page.locator(".once-reader-host-frame").contentFrame()
  await expect(reader.getByRole("heading", { name: "Fixture article" })).toBeVisible()
  await expect(reader.locator("body")).toHaveCSS("max-width", "700px")
  await expect(reader.locator(".toolbar")).toBeHidden()
  await expect(reader.locator(".reader-original")).toBeHidden()
  await expect(page.getByTestId("reader-tts-bar")).toBeVisible()
  await expect(reader.locator("html")).toHaveAttribute("data-once-tts-installed", "true")
  await expect(reader.locator("article .tts-segment")).not.toHaveCount(0)
  await page.getByTestId("stories-menu").click()
  // Switching tabs hides Reading but preserves it as a persistent workspace.
  await expect(page.locator(".once-reader-host-frame")).toBeAttached()
  await page.getByTestId("reading-menu").click()
  await expect(reader.getByRole("heading", { name: "Fixture article" })).toBeVisible()
  await expect(page.locator("#reading_content")).toHaveAttribute("data-mode", "reader")
  await page.getByTestId("stories-menu").click()

  await openStoryMenu(page, story)
  await page.getByTestId("story-menu-toggle-read").click()
  await openStoryMenu(page, story)
  await page.getByTestId("story-menu-toggle-read").click()
  await expect(story).toHaveClass(/skipped/)
  await page.evaluate(() => window.__onceE2E__.settledStoryWrites())
  await reloadMobileApp(page)
  await page.getByTestId("stories-menu").click()
  await page.getByTestId("reload-stories").click()
  await expect(page.getByTestId("story").filter({ hasText: "Fixture article" })).toHaveClass(/skipped/)
})

test("authenticated PouchDB sync pulls and pushes deterministic settings", async ({
  page,
  request,
  baseURL
}) => {
  const database = "web_sync"
  const server = new URL(baseURL).origin
  await request.post(`${server}/test/databases/${database}/reset`, {
    data: { docs: [{ _id: "theme", list: "light" }] }
  })
  await gotoMobileApp(page)
  await openSettingsSection(page, "sync")
  await page.getByTestId("sync-url").fill(
    `${server.replace("http://", "http://once-test:once-test@")}/db/${database}`
  )
  await page.getByTestId("save-sync").click()
  await expect(page.locator("body")).toHaveAttribute("data-theme", "light", { timeout: 15_000 })

  await openSettingsSection(page, "theme")
  await page.getByTestId("theme").selectOption("dark")
  await expect.poll(async () => {
    const response = await request.get(`${server}/db/${database}/theme`, {
      headers: { Authorization: `Basic ${Buffer.from("once-test:once-test").toString("base64")}` }
    })
    return response.ok() ? (await response.json()).list : "pending"
  }, { timeout: 15_000 }).toBe("dark")

  await reloadMobileApp(page)
  await expect(page.locator("body")).toHaveAttribute("data-theme", "dark")
})
