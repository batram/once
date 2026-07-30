const { test, expect } = require("@playwright/test")
const { gotoMobileApp } = require("./helpers/mobile-app")
const { openSettingsSection } = require("./helpers/settings")

test("mobile layout is present before application JavaScript starts", async ({ page }) => {
  await page.route("**/mobile.js", (route) => route.abort())
  await page.goto("./", { waitUntil: "domcontentloaded" })

  await expect(page.locator('link[rel="stylesheet"][href="mobile.css"]'))
    .toHaveCount(1)
  await expect(page.locator("body")).toHaveAttribute("data-platform", "mobile")
  await expect(page.locator("#right_panel")).toBeHidden()
  await expect(page.locator("#menu")).toHaveCSS("position", "fixed")
  await expect(page.locator("#menu")).toHaveCSS("bottom", "0px")
  await expect.poll(() => page.locator("#reload_stories_btn").evaluate(
    (button) => getComputedStyle(button, "::before").webkitMaskImage
  )).toContain("/app/imgs/reload.svg")
})

test("interactive navigation waits for a slow application startup", async ({
  page
}) => {
  let releaseBundle
  let markBundleRequested
  const bundleReleased = new Promise((resolve) => {
    releaseBundle = resolve
  })
  const bundleRequested = new Promise((resolve) => {
    markBundleRequested = resolve
  })
  await page.route("**/mobile.js", async (route) => {
    markBundleRequested()
    await bundleReleased
    await route.continue()
  })

  const navigation = gotoMobileApp(page)
  await bundleRequested
  await expect(page.locator("body")).not.toHaveAttribute(
    "data-once-ready",
    "true"
  )
  releaseBundle()
  await navigation

  await page.getByTestId("settings-menu").click()
  await expect(page.locator("#settings_search")).toBeVisible()
})

test("mobile shell is responsive and hides unavailable capabilities", async ({ page }) => {
  await gotoMobileApp(page)
  await expect(page.locator("body")).toHaveAttribute("data-platform", "mobile")
  await expect(page.locator("body")).toHaveAttribute("data-once-ready", "true")
  await expect(page.getByTestId("app-version")).toContainText("dev")
  await expect(page.getByTestId("pick-source")).toBeHidden()
  await expect(page.getByTestId("settings-menu")).toBeVisible()
  await expect(page.getByTestId("stories-menu")).toBeVisible()
  expect(await page.locator("#left_panel").evaluate((element) => element.scrollWidth <= window.innerWidth)).toBe(true)
  const trailingStorySpace = await page.locator("#stories").evaluate((stories) => {
    const finalStory = document.createElement("article")
    finalStory.style.cssText = "display:block;flex:0 0 1200px;height:1200px"
    stories.replaceChildren(finalStory)
    stories.scrollTop = stories.scrollHeight
    const menu = document.querySelector("#menu")
    return menu.getBoundingClientRect().top -
      finalStory.getBoundingClientRect().bottom
  })
  expect(trailingStorySpace).toBeGreaterThanOrEqual(0)
  expect(trailingStorySpace).toBeLessThanOrEqual(1)
})

test("mobile refresh controls stay separated and theme-aware", async ({ page }) => {
  await gotoMobileApp(page)
  await expect(page.locator("body")).toHaveAttribute("data-once-ready", "true")

  const refreshControls = await page.evaluate(() => {
    const reload = document.querySelector("#reload_stories_btn")
    const reading = document.querySelector("#reading_navigate")
    const reloadStyle = getComputedStyle(reload)
    const readingStyle = getComputedStyle(reading)
    reload.classList.add("disabled")
    reading.classList.add("loading")
    reading.disabled = true
    return {
      reload: {
        width: reloadStyle.width,
        height: reloadStyle.height,
        border: reloadStyle.border,
        radius: reloadStyle.borderRadius,
        background: reloadStyle.backgroundColor
      },
      reading: {
        width: readingStyle.width,
        height: readingStyle.height,
        border: readingStyle.border,
        radius: readingStyle.borderRadius,
        background: readingStyle.backgroundColor
      },
      reloadOpacity: getComputedStyle(reload).opacity,
      readingOpacity: getComputedStyle(reading).opacity,
      reloadAnimation: getComputedStyle(reload, "::before").animationName,
      readingAnimation: getComputedStyle(reading, "::before").animationName,
      readingMask: getComputedStyle(reading, "::before").webkitMaskImage
    }
  })
  expect(refreshControls.reading).toEqual(refreshControls.reload)
  expect(refreshControls.reloadOpacity).toBe("1")
  expect(refreshControls.readingOpacity).toBe("1")
  expect(refreshControls.reloadAnimation).toBe("rotating")
  expect(refreshControls.readingAnimation).toBe("rotating")
  expect(refreshControls.readingMask).toContain("reload.svg")

  const listTopBeforePull = await page.locator("#stories").evaluate(
    (stories) => stories.getBoundingClientRect().top
  )
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
  const pullGeometry = await page.locator("#stories").evaluate((stories) => {
    const indicator = stories.querySelector(".ptr-indicator")
    const surface = indicator.querySelector(".ptr-surface")
    const listBounds = stories.getBoundingClientRect()
    const indicatorBounds = indicator.getBoundingClientRect()
    const surfaceBounds = surface.getBoundingClientRect()
    return {
      listTop: listBounds.top,
      indicatorTop: indicatorBounds.top,
      indicatorBottom: indicatorBounds.bottom,
      surfaceTop: surfaceBounds.top,
      surfaceBottom: surfaceBounds.bottom,
      indicatorPosition: getComputedStyle(indicator).position
    }
  })
  expect(pullGeometry.listTop).toBe(listTopBeforePull)
  expect(pullGeometry.indicatorPosition).toBe("absolute")
  expect(pullGeometry.indicatorTop).toBe(listTopBeforePull)
  expect(pullGeometry.surfaceTop).toBeLessThan(pullGeometry.indicatorBottom)
  expect(pullGeometry.surfaceBottom).toBeGreaterThan(listTopBeforePull)
  expect(
    pullGeometry.indicatorBottom - pullGeometry.surfaceBottom
  ).toBeGreaterThanOrEqual(10)

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

test("theme and phone navigation survive orientation changes", async ({ page }) => {
  await gotoMobileApp(page)
  await openSettingsSection(page, "theme")
  await page.getByTestId("theme").selectOption("light")
  await expect(page.locator("body")).toHaveAttribute("data-theme", "light")
  await page.setViewportSize({ width: 915, height: 412 })
  await expect(page.getByTestId("stories-menu")).toBeVisible()
  await expect(page.locator("#left_panel")).toHaveCSS("min-width", "0px")
})
