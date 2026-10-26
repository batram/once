const { test, expect } = require("@playwright/test")
const { gotoMobileApp } = require("./helpers/mobile-app")

async function touch(page, row, dx) {
  const bounds = await row.boundingBox()
  const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2
  const input = await page.context().newCDPSession(page)
  await input.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] })
  for (let step = 1; step <= 5; step++) {
    await input.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + dx * step / 5, y }] })
  }
  return async () => {
    await input.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
    await input.detach()
  }
}

async function seedVisits(page, visits) {
  await page.evaluate(async visits => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("once-browser-history", 1)
      request.onupgradeneeded = () => { request.result.createObjectStore("visits", { keyPath: "id" }).createIndex("time", ["visitedAt", "id"]) }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    await new Promise((resolve, reject) => {
      const tx = db.transaction("visits", "readwrite")
      for (const visit of visits) tx.objectStore("visits").put(visit)
      tx.oncomplete = resolve
      tx.onabort = () => reject(tx.error)
    })
    db.close()
  }, visits)
}

async function openHistory(page) {
  await page.getByTestId("reading-menu").click()
  await page.getByRole("button", { name: "Browser menu", exact: true }).click()
  await page.getByRole("button", { name: "History", exact: true }).click()
  await expect(page.locator(".browser-history h1")).toHaveText("History")
  await expect(page.locator('#menu [data-panel="browser_history"]')).toHaveCount(0)
  await expect(page.locator("#browser_history_panel h1")).toHaveCount(1)
}

test("browser history opens from the menu, searches, deletes, and survives restart", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await gotoMobileApp(page)
  await openHistory(page)
  await expect(page.locator(".history-status")).toHaveText("No browsing history yet.")
  await expect(page.locator(".history-empty-hint")).toBeVisible()
  await expect(page.locator(".history-pagination")).toBeHidden()
  await page.screenshot({ path: "test-results/history-mobile-empty.png" })
  await page.getByTestId("browser_history-panel-close").click()
  await page.getByTestId("reading-menu").click()
  const url = new URL("/fixtures/article.html", page.url()).href
  await page.locator("#reading_url").fill(url)
  await page.locator("#reading_url").press("Enter")
  await page.evaluate(url => window.__onceE2E__.finishReading(url), url)
  await openHistory(page)
  await expect(page.locator(".history-entry")).toHaveCount(1)
  await page.reload()
  await expect(page.locator("body")).toHaveAttribute("data-once-ready", "true")
  await openHistory(page)
  await expect(page.locator(".history-entry")).toHaveCount(1)
  await page.getByRole("searchbox").fill("not-in-history")
  await expect(page.locator(".history-status")).toHaveText("No matching visits.")
  await page.getByRole("searchbox").fill("article")
  await expect(page.locator(".history-entry")).toHaveCount(1)
  await page.screenshot({ path: "test-results/history-mobile-search.png" })
  await page.locator(".history-remove").click()
  await expect(page.locator(".history-entry")).toHaveCount(0)
  await expect(page.locator(".history-status")).toHaveText("No matching visits.")
  await expect(page.locator(".history-empty-hint")).toBeHidden()
})

test("opening a visit leaves History for the page", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await gotoMobileApp(page)
  const url = new URL("/fixtures/article.html", page.url()).href
  await seedVisits(page, [{ id: "seed", url, title: "Article", visitedAt: Date.now() }])
  await openHistory(page)
  await page.locator(".history-entry a").click()
  await expect(page.locator("#left_panel")).toHaveAttribute("active_panel", "reading")
  await expect(page.locator("#browser_history_panel")).toHaveCount(0)
  await expect(page.locator("#reading_url")).toHaveValue(url)
})

test("history rows swipe like tab rows: left deletes the visit, right opens it", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await gotoMobileApp(page)
  const url = new URL("/fixtures/article.html", page.url()).href
  await seedVisits(page, [
    { id: "keep", url, title: "Article", visitedAt: 1700000000000 },
    { id: "drop", url: "https://example.test/drop", title: "Dropped", visitedAt: 1700000001000 }
  ])
  await openHistory(page)
  const rows = page.locator(".history-entry")
  await expect(rows).toHaveCount(2)
  const releaseDelete = await touch(page, rows.first(), -100)
  await expect(rows.first()).toHaveAttribute("data-swipe-direction", "delete")
  await expect(rows.first()).toHaveAttribute("data-swipe-ready", "true")
  await expect(rows.first().locator(".history-swipe-hint")).toHaveText("Release to delete")
  await expect(rows.first()).toHaveAttribute("style", /--row-swipe-distance: 100px/)
  const feedback = await rows.first().evaluate(row => ({
    hint: row.querySelector(".history-swipe-hint").getBoundingClientRect().width,
    transform: getComputedStyle(row.querySelector("a")).transform,
    overflow: document.documentElement.scrollWidth > innerWidth
  }))
  expect(feedback.hint).toBeCloseTo(100, 0)
  expect(feedback.transform).toContain("-100")
  expect(feedback.overflow).toBe(false)
  await page.screenshot({ path: "test-results/history-mobile-swipe-delete.png" })
  await releaseDelete()
  await expect(rows).toHaveCount(1)
  await expect(rows.first().locator(".history-entry-title")).toHaveText("Article")
  // A short drag reveals the action but releases without committing.
  const releaseShort = await touch(page, rows.first(), 40)
  await expect(rows.first()).toHaveAttribute("data-swipe-direction", "open")
  await expect(rows.first()).toHaveAttribute("data-swipe-ready", "false")
  await releaseShort()
  await expect(rows.first()).not.toHaveAttribute("data-swipe-direction")
  await expect(page.locator("#browser_history_panel")).toHaveCount(1)
  const releaseOpen = await touch(page, rows.first(), 100)
  await expect(rows.first().locator(".history-swipe-hint")).toHaveText("Release to open")
  await page.screenshot({ path: "test-results/history-mobile-swipe-open.png" })
  await releaseOpen()
  await expect(page.locator("#left_panel")).toHaveAttribute("active_panel", "reading")
  await expect(page.locator("#reading_url")).toHaveValue(url)
})

test("history stays bounded, fits phone sizes in both themes, and clears all search results", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 })
  await gotoMobileApp(page)
  // Reproduce the iPhone status-bar and home-indicator runways in the web preview.
  await page.addStyleTag({ content: "body { padding-top: 59px; --m-tabbar-inset: 18px; }" })
  await openHistory(page)
  await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("once-browser-history", 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    await new Promise((resolve, reject) => {
      const tx = db.transaction("visits", "readwrite")
      const store = tx.objectStore("visits")
      for (let index = 0; index < 120; index++) store.put({ id: String(index).padStart(3, "0"),
        url: `https://example.test/${"long-address/".repeat(20)}${index}`, title: `${index % 2 ? "Other" : "Match"} ${"long title ".repeat(20)}${index}`, visitedAt: 1700000000000 + index })
      tx.oncomplete = resolve
      tx.onabort = () => reject(tx.error)
    })
    db.close()
  })
  await page.getByTestId("browser_history-panel-close").click()
  await openHistory(page)
  await expect(page.locator(".history-entry")).toHaveCount(50)
  for (const theme of ["light", "dark"]) {
    await page.evaluate(theme => { document.body.dataset.theme = theme }, theme)
    for (const width of [320, 390, 768]) {
      await page.setViewportSize({ width, height: 844 })
      const toolbar = await page.locator(".history-header").evaluate(header => {
        const box = header.getBoundingClientRect()
        return { top: box.top, bottom: box.bottom, height: box.height,
          controls: Array.from(header.querySelectorAll("button"), button => {
            const bounds = button.getBoundingClientRect()
            return { top: bounds.top, bottom: bounds.bottom, center: bounds.top + bounds.height / 2,
              width: bounds.width, height: bounds.height, margin: getComputedStyle(button).margin }
          }) }
      })
      expect(toolbar.top).toBe(59)
      expect(toolbar.height).toBe(52)
      expect(toolbar.controls).toHaveLength(2)
      for (const control of toolbar.controls) {
        expect(control.top).toBeGreaterThanOrEqual(toolbar.top)
        expect(control.bottom).toBeLessThanOrEqual(toolbar.bottom)
        expect(control.width).toBeGreaterThanOrEqual(44)
        expect(control.height).toBe(44)
        expect(control.margin).toBe("0px")
      }
      expect(Math.abs(toolbar.controls[0].center - toolbar.controls[1].center)).toBeLessThan(1)
      const geometry = await page.locator(".browser-history").evaluate(root => {
        const input = root.querySelector("input").getBoundingClientRect()
        const row = root.querySelector(".history-entry").getBoundingClientRect()
        const remove = root.querySelector(".history-remove").getBoundingClientRect()
        const time = root.querySelector("time")
        const timeBox = time.getBoundingClientRect()
        const title = root.querySelector(".history-entry-title").getBoundingClientRect()
        return { time: time.textContent, timeInset: timeBox.left - row.left, titleTop: title.top, timeTop: timeBox.top, overflow: root.scrollWidth > root.clientWidth, inputRight: input.right, rowRight: row.right, removeWidth: remove.width, removeHeight: remove.height, viewport: innerWidth }
      })
      expect(geometry.time).toMatch(/^\d{2}:\d{2}$/)
      expect(geometry.timeInset).toBeGreaterThanOrEqual(8)
      expect(Math.abs(geometry.timeTop - geometry.titleTop)).toBeLessThan(5)
      expect(geometry.overflow).toBe(false)
      expect(geometry.rowRight).toBeLessThanOrEqual(geometry.viewport)
      expect(geometry.inputRight).toBeLessThanOrEqual(geometry.viewport)
      expect(geometry.removeWidth).toBeGreaterThanOrEqual(43)
      expect(geometry.removeHeight).toBeGreaterThanOrEqual(43)
      await page.screenshot({ path: `test-results/history-mobile-${theme}-${width}.png` })
    }
  }
  await page.locator(".history-older").click()
  await expect(page.locator(".history-entry")).toHaveCount(50)
  await page.locator(".history-older").click()
  await expect(page.locator(".history-entry")).toHaveCount(20)
  await expect(page.locator(".history-older")).toBeHidden()
  await page.locator(".history-newer").click()
  await expect(page.locator(".history-entry")).toHaveCount(50)
  await page.getByRole("searchbox").fill("Match")
  await expect(page.locator(".history-entry")).toHaveCount(50)
  await page.locator(".history-clear").click()
  await page.locator(".history-cancel").click()
  await expect(page.locator(".history-entry")).toHaveCount(50)
  await page.locator(".history-clear").click()
  await page.locator(".history-confirm-delete").click()
  await expect(page.locator(".history-status")).toHaveText("No browsing history yet.")
  await expect(page.getByRole("searchbox")).toHaveValue("")
  expect(await page.evaluate(() => window.__onceE2E__.handleBack())).toBe(true)
  await expect(page.locator("#left_panel")).toHaveAttribute("active_panel", "reading")
})
