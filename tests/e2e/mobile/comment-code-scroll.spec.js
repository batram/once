const { test, expect } = require("@playwright/test")
const { seedFixtureStories } = require("./helpers/stories")
const { openSettingsSection } = require("./helpers/settings")

// The shape and long firmware-log lines from HN comment 50517526. Exercise
// bare <pre> too: the scroll owner is often an ancestor of the touch target.
const log = "  [    2.920022] i915 0000:00:02.0: firmware: failed to load i915/kbl_dmc_ver1_04.bin (-2)\n\n" +
  "  [    3.818174] r8169 0000:02:00.0: firmware: failed to load rtl_nic/rtl8168h-2.fw (-2)\n"
const storyUrl = "https://news.ycombinator.com/item?id=50514180"

// Browser-level touch input is essential: DOM-dispatched TouchEvents cannot
// prove that native scrolling works after the comment gesture yields.
async function drag(cdp, target, dx, dy = 0) {
  // A previous comment swipe eases home; measure after that transform ends
  // so the next touch does not accidentally begin in the shell's edge strip.
  await target.evaluate(async el => {
    await Promise.all(el.closest(".comment_main").getAnimations().map(animation => animation.finished))
  })
  const box = await target.boundingBox()
  const x = dx < 0 ? box.x + box.width - 45 : box.x + 45
  const y = box.y + Math.min(box.height / 2, 12)
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart", touchPoints: [{ x, y }]
  })
  for (let step = 1; step <= 8; step++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: x + dx * step / 8, y: y + dy * step / 8 }]
    })
    // Sample a finger moving over time, within the comment swipe's window.
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
}

for (const [theme, width] of [["light", 320], ["dark", 412]]) {
  for (const nestedCode of [true, false]) {
    test(`comment ${nestedCode ? "pre/code" : "pre"} scrolls by touch in ${theme} at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 820 })
      await page.route("**/fixtures/feed.rss", async route => {
        const response = await route.fetch()
        const article = new URL("/fixtures/article.html", route.request().url()).href
        await route.fulfill({ response, body: (await response.text()).replaceAll(article, storyUrl) })
      })
      await page.route("https://hn.algolia.com/api/v1/items/50514180", route => route.fulfill({
        json: {
          id: 50514180, title: "Code scrolling discussion",
          children: [{
            id: 50517526, type: "comment", author: "RetroTechie",
            text: `<p>In that <code>dmesg</code> log</p><pre>${nestedCode ? `<code>${log}</code>` : log}</pre>` +
              "<p>More discussion below the log.</p>".repeat(30),
            children: []
          }]
        }
      }))
      const story = await seedFixtureStories(page)
      await openSettingsSection(page, "theme")
      await page.getByTestId("theme").selectOption(theme)
      await page.getByTestId("stories-menu").click()
      await story.getByTestId("story-menu-button").click()
      await page.getByTestId("story-menu-open-comments").click()
      const comment = page.locator('.comment[data-id="50517526"]')
      const pre = comment.locator("pre")
      const host = page.getByTestId("reading-comment-thread")
      await expect(pre).toBeVisible()
      const geometry = await pre.evaluate(el => {
        const host = el.closest(".reading_comment_thread")
        const rect = el.getBoundingClientRect()
        return {
          width: el.clientWidth, scrollWidth: el.scrollWidth,
          overflow: getComputedStyle(el).overflowX,
          withinViewport: rect.left >= 0 && rect.right <= innerWidth,
          hostOverflow: host.scrollWidth > host.clientWidth
        }
      })
      expect(geometry.scrollWidth).toBeGreaterThan(geometry.width)
      expect(geometry.overflow).toBe("auto")
      expect(geometry.withinViewport).toBe(true)
      expect(geometry.hostOverflow).toBe(false)
      expect(await pre.evaluate(el => {
        const rect = el.getBoundingClientRect()
        return document.elementFromPoint(rect.right - 45, rect.top + 12).tagName
      })).toBe(nestedCode ? "CODE" : "PRE")

      const cdp = await page.context().newCDPSession(page)
      const unchanged = async () => {
        await expect(comment).not.toHaveClass(/is-collapsed|is-focused/)
        await expect(comment.locator(".comment_main")).not.toHaveClass(/is-swiping/)
        expect(await host.evaluate(el => el.scrollLeft)).toBe(0)
      }
      try {
        await drag(cdp, pre, -140)
        await expect.poll(() => pre.evaluate(el => el.scrollLeft)).toBeGreaterThan(50)
        await unchanged()
        await page.screenshot({ path: test.info().outputPath("code-scrolled.png") })

        // At either boundary, further panning must not turn into collapse/focus.
        await pre.evaluate(el => { el.scrollLeft = el.scrollWidth })
        await drag(cdp, pre, -140)
        await unchanged()
        const rightEdge = await pre.evaluate(el => el.scrollLeft)
        await drag(cdp, pre, 140)
        await expect.poll(() => pre.evaluate(el => el.scrollLeft)).toBeLessThan(rightEdge - 50)
        await unchanged()
        await pre.evaluate(el => { el.scrollLeft = 0 })
        await drag(cdp, pre, 140)
        await unchanged()

        // A vertical drag on the code still scrolls the discussion around it.
        await drag(cdp, pre, 0, -100)
        await expect.poll(() => host.evaluate(el => el.scrollTop)).toBeGreaterThan(30)
        await unchanged()
        await host.evaluate(el => { el.scrollTop = 0 })

        // Non-overflowing inline code keeps the ordinary comment gestures,
        // and a collapsed code preview can still be swiped open.
        await drag(cdp, comment.locator(".comment_body > p").first(), -140)
        await expect(comment).toHaveClass(/is-collapsed/)
        await drag(cdp, comment.locator(".comment_main"), 140)
        await expect(comment).not.toHaveClass(/is-collapsed/)
      } finally {
        await cdp.detach()
      }
    })
  }
}
