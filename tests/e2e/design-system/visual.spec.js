const { test, expect } = require("@playwright/test")

const { createServer } = require("./static-server")

let server
let baseURL

test.beforeAll(async () => {
  server = createServer()
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  baseURL = `http://127.0.0.1:${server.address().port}`
})

test.afterAll(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
})

async function prepareStories(page, target = "") {
  await page.goto(`${baseURL}/static/sidepanel.html${target}`)
  await page.evaluate(() => {
    document.body.setAttribute("animated", "false")
    document.body.dataset.theme = "light"
    const leftPanel = document.querySelector("#left_panel")
    leftPanel?.setAttribute("active_panel", "stories")
    const stories = document.querySelector("#stories")
    if (!stories) return
    const chips = document.querySelector("#mobile_filter_chips")
    if (chips) {
      chips.innerHTML = ["[ALL]", "[filtered]", "[stared]", "[new]", "[HN]"]
        .map((label) => `<button type="button" class="button mobile_filter_chip">${label}</button>`)
        .join("")
    }
    stories.innerHTML = [
      ["Postgres rewritten in Rust v0.2, now faster than Postgres and ClickHouse", "github.com", "malisper", "4 mins ago"],
      ["Physicists Solve a Muon Mystery. Now, Old Results Don’t Add Up", "quantamagazine.org", "ibobev", "46 mins ago"],
      ["RCade: The Arcade Cabinet with CI/CD Deployment, Custom Graphics Card for CRT [video]", "youtube.com", "chistev", "1 hour ago"]
    ].map(([title, host, user, age]) => `
      <article class="story">
        <div class="data">
          <div class="title_line">
            <a class="title">${title}</a>
            <span class="hostname"> (${host})</span>
          </div>
          <div class="substories">
            <div class="info" data-type="[HN]">
              <span class="type">HN</span>
              <a class="comment_url">[comments]</a>
              <span class="time">${age}</span>
              <span class="tags_container">
                <span class="tag">${user}</span>
                <span class="tag">*default</span>
              </span>
            </div>
          </div>
        </div>
        <div class="button_group">
          <button type="button" class="button filter_btn" aria-label="Filter">
            <img src="imgs/filter.svg" alt="">
          </button>
          <button type="button" class="button star_btn" aria-label="Star"></button>
          <button type="button" class="button read_btn" aria-label="Read"></button>
        </div>
        <button type="button" class="button button--icon menu_btn" aria-label="Story actions">⋮</button>
      </article>
    `).join("")
  })
  await page.locator("img").evaluateAll((images) =>
    Promise.all(images.map((image) => image.decode().catch(() => undefined)))
  )
}

test("shared desktop shell keeps its visual shape", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 600 })
  await prepareStories(page)
  await expect(page).toHaveScreenshot("shared-shell.png", {
    animations: "disabled",
    caret: "hide"
  })
})

test("Electron shell keeps its visual shape", async ({ page }) => {
  await page.setViewportSize({ width: 594, height: 617 })
  await prepareStories(page, "?target=electron")
  await expect(page).toHaveScreenshot("electron-shell.png", {
    animations: "disabled",
    caret: "hide"
  })
})

test("mobile shell keeps its visual shape", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await prepareStories(page, "?target=mobile")
  for (const selector of [
    "#stories_menu_btn > .heading",
    "#reading_menu_btn",
    "#settings_menu_btn"
  ]) {
    await expect(page.locator(selector)).toBeVisible()
  }
  const tabBounds = await page.locator(
    "#stories_menu_btn > .heading, #reading_menu_btn, #settings_menu_btn"
  ).evaluateAll((tabs) => tabs.map((tab) => {
    const bounds = tab.getBoundingClientRect()
    return {
      left: bounds.left,
      right: bounds.right,
      top: bounds.top,
      bottom: bounds.bottom,
      opacity: getComputedStyle(tab).opacity
    }
  }))
  expect(tabBounds).toHaveLength(3)
  for (const bounds of tabBounds) {
    expect(bounds.left).toBeGreaterThanOrEqual(0)
    expect(bounds.right).toBeLessThanOrEqual(390)
    expect(bounds.top).toBeGreaterThanOrEqual(790)
    expect(bounds.bottom).toBeLessThanOrEqual(844)
    expect(Number(bounds.opacity)).toBeGreaterThan(0)
  }
  await expect(page).toHaveScreenshot("mobile-shell.png", {
    animations: "disabled",
    caret: "hide"
  })
})
