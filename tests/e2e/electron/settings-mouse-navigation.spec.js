const { test, expect } = require("@playwright/test")
const { launchApp, closeApp, openPanel, seedRedirects } = require("./electron-harness")

test("mouse navigation returns to Stories and repeatedly restores redirect drafts", async () => {
  const { electronApp, userData, window } = await launchApp()
  try {
    await seedRedirects(window)
    await openPanel(window, "stories")
    const cdp = await window.context().newCDPSession(window)
    const mouse = async button => {
      // Native Chromium input, not a synthetic DOM event: this also exercises
      // default browser navigation and the complete press/release gesture.
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", button, buttons: button === "back" ? 8 : 16, x: 170, y: 150, clickCount: 1 })
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", button, buttons: 0, x: 170, y: 150, clickCount: 1 })
    }
    const panel = window.locator("#left_panel")
    const form = window.locator(".structured_redirect_form")
    for (let cycle = 0; cycle < 3; cycle++) {
      await openPanel(window, "settings")
      await mouse("back")
      await expect(panel).toHaveAttribute("active_panel", "stories")
      await mouse("forward")
      await expect(panel).toHaveAttribute("active_panel", "settings")
      await window.locator('[data-settings-target="redirects"]').click()
      await window.getByTestId("redirect-row").first().click()
      const draft = `https://redirect.example/${cycle}/$1`
      await form.locator("textarea").nth(1).fill(draft)
      await form.locator(".structured_redirect_test_input").fill("https://www.reddit.com/r/example/comments/123/a_long_article_title")
      for (let repeat = 0; repeat < 3; repeat++) {
        await mouse("back")
        await expect(form).toHaveCount(0)
        await expect(window.locator(".settings_section.active")).toHaveAttribute("data-settings-section", "redirects")
        await mouse("forward")
        await expect(form).toBeVisible()
        await expect(form.locator("textarea").nth(1)).toHaveValue(draft)
        await expect(form.locator(".structured_redirect_test_input")).toHaveValue("https://www.reddit.com/r/example/comments/123/a_long_article_title")
      }
      await mouse("back")
      await mouse("back")
      await expect(window.locator("#settings_index")).toBeVisible()
      await mouse("forward")
      await expect(form).toHaveCount(0)
      await mouse("forward")
      await expect(form.locator("textarea").nth(1)).toHaveValue(draft)
      const layout = await form.evaluate(element => {
        const field = element.querySelector(".settings_row").getBoundingClientRect()
        const input = element.querySelector("textarea").getBoundingClientRect()
        return { ratio: input.width / field.width, overflow: element.scrollWidth > element.clientWidth }
      })
      expect(layout.ratio).toBeGreaterThan(0.95)
      expect(layout.overflow).toBe(false)
      if (cycle === 0) await window.locator("#settings_panel").screenshot({ path: "test-results/redirect-editor-layout.png" })
      if (cycle === 2) {
        await form.getByTestId("structured-save").click()
        await expect(window.getByTestId("redirect-row").first()).toContainText(draft)
      } else await form.getByRole("button", { name: "Cancel", exact: true }).click()
      await mouse("forward")
      await expect(form).toHaveCount(0)
      await openPanel(window, "stories")
    }
    await cdp.detach()
  } finally {
    await closeApp(electronApp, userData)
  }
})
