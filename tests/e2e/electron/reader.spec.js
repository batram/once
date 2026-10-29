const { test, expect } = require("./electron-harness")
const {
  closeApp,
  launchApp,
  openSettingsSection,
  seedLocalSource,
  showAllStories,
  startPageServer
} = require("./electron-harness")
const storyFixture = require("../shared/story-fixture")

let pageServer
let origin

test.beforeAll(async () => {
  pageServer = await startPageServer()
  origin = pageServer.origin
})

test.afterAll(async () => {
  await pageServer.close()
})

// A served reader document's URL carries its random token as the host and the
// source as its path. The address bar still shows the readable form.
function readerUrl(sourceUrl) {
  const escaped = sourceUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return expect.stringMatching(new RegExp(`^once-reader://[a-f0-9]{32}/${escaped}$`))
}

test("a bookmarked story's saved article opens in the reader after its site is gone", async () => {
  // Its own fixture server, because the point is to take it away mid-test.
  const server = await startPageServer()
  const urls = storyFixture.storyUrls(server.origin)
  const { electronApp, userData, window } = await launchApp({
    env: { ONCE_ELECTRON_DISABLE_NETWORK_FETCH: "0" }
  })
  try {
    await seedLocalSource(window, storyFixture.sourceLine(server.origin), urls.alpha)
    const toggle = await openSettingsSection(window, "theme", "#save_bookmarked_checkbox")
    await toggle.check()
    await showAllStories(window)
    const alpha = window.locator(`#stories story-item[data-href="${urls.alpha}"]`)
    // Bookmarking fetches and stores the article; the reader button says so.
    await alpha.locator(".star_btn").click()
    await expect(alpha).toHaveClass(/stared/)
    await expect(alpha.locator(".outline_btn .icon--stored-content")).toHaveCount(1, {
      timeout: 15_000
    })

    await server.close()
    await alpha.locator(".outline_btn").click()
    // The first story takes over the window's untouched blank tab.
    await expect(window.locator(".electron-tab-title")).toContainText(
      storyFixture.STORY_TITLES.alpha
    )
    await expect.poll(() => window.evaluate(() => window.onceElectron.tabs.getAll()))
      .toMatchObject([{
        url: expect.stringMatching(/^once-reader:\/\//),
        active: true,
        loadError: null
      }])
  } finally {
    await closeApp(electronApp, userData)
    await server.close().catch(() => undefined)
  }
})

test("duplicates a reader tab into a second reader tab", async () => {
  const { electronApp, userData, window } = await launchApp()
  try {
    // "current" replaces the initial tab in place, which keeps the tab
    // arithmetic below about duplication alone.
    await window.evaluate(({ html, sourceUrl }) =>
      window.onceElectron.tabs.openReader(html, sourceUrl, "current"),
    {
      html: "<!doctype html><title>Reader Article</title><h1>Reader body</h1>",
      sourceUrl: "https://example.com/article"
    })
    await expect(window.locator(".electron-tab-title")).toHaveText("Reader Article")

    const [readerTab] = await window.evaluate(() => window.onceElectron.tabs.getAll())
    expect(readerTab.url).toMatch(/^once-reader:\/\//)

    await window.evaluate((id) => window.onceElectron.tabs.duplicate(id), readerTab.id)
    await expect(window.locator(".electron-tab")).toHaveCount(2)
    await expect(window.locator(".electron-tab-title").nth(1)).toHaveText("Reader Article")
    await expect.poll(() => window.evaluate(async () =>
      (await window.onceElectron.tabs.getAll()).map((tab) => ({
        url: tab.url,
        active: tab.active,
        loadError: tab.loadError
      }))
    )).toEqual([
      { url: readerTab.url, active: false, loadError: null },
      { url: readerTab.url, active: true, loadError: null }
    ])

    await window.evaluate(() => window.onceElectron.tabs.create("about:blank", true))
    await expect(window.locator(".electron-tab")).toHaveCount(3)
    const address = window.locator("#urlfield")
    await address.fill("once-reader://https://example.com/article")
    await address.press("Enter")
    await expect(window.locator(".electron-tab-title").nth(2)).toHaveText("Reader Article")
    await expect(address).toHaveValue("once-reader://https://example.com/article")
    await expect(window.locator("#url_error")).toBeHidden()

    await address.fill("once-reader://https://example.com/never-opened")
    await address.press("Enter")
    await expect(window.locator("#url_error")).toBeHidden()
    // A failed extraction opens a reader page that states the error, in the same tab.
    await expect(window.locator(".electron-tab-title").nth(2)).toHaveText("Reader mode")
    await expect(address).toHaveValue("once-reader://https://example.com/never-opened")
    await expect.poll(() => electronApp.evaluate(async ({ webContents }) => {
      const contents = webContents
        .getAllWebContents()
        .find((candidate) => candidate.getURL().startsWith("once-reader://") && candidate.getURL().includes("never-opened"))
      if (!contents) return null
      return contents.executeJavaScript("document.querySelector('[data-reader-error]')?.textContent ?? null")
    })).toContain("Network fetches are disabled")
  } finally {
    await closeApp(electronApp, userData)
  }
})

test("a reader error page's Try again reads the article afresh", async () => {
  const { electronApp, userData, window } = await launchApp({
    env: { ONCE_ELECTRON_DISABLE_NETWORK_FETCH: "0" }
  })
  try {
    const address = window.locator("#urlfield")
    await address.fill(`once-reader://${origin}/article-after-outage`)
    await address.press("Enter")
    const title = window.locator(".electron-tab-title")
    await expect(title).toHaveText("Reader mode")
    // The error page sits in the tab's own view, out of reach of the shell's locators.
    await expect.poll(() => electronApp.evaluate(async ({ webContents }) => {
      const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL().includes("article-after-outage"))
      return contents ? contents.executeJavaScript("(link => { link?.click(); return Boolean(link) })(document.querySelector('[data-reader-retry]'))").catch(() => false) : false
    })).toBe(true)
    await expect(title).toHaveText("Recovered Article")
    await expect(address).toHaveValue(`once-reader://${origin}/article-after-outage`)
  } finally {
    await closeApp(electronApp, userData)
  }
})

test("reads an article served as application/xhtml+xml", async () => {
  const { electronApp, userData, window } = await launchApp({
    env: { ONCE_ELECTRON_DISABLE_NETWORK_FETCH: "0" }
  })
  try {
    const address = window.locator("#urlfield")
    await address.fill(`${origin}/article.xhtml`)
    await address.press("Enter")
    await expect(window.locator(".electron-tab-title")).toHaveText("XHTML Article")

    await window.locator("#browser_reader").click()
    await expect.poll(() => window.evaluate(async () => {
      const active = (await window.onceElectron.tabs.getAll()).find((tab) => tab.active)
      return active && { url: active.url, title: active.title, loadError: active.loadError }
    })).toEqual({
      url: readerUrl(`${origin}/article.xhtml`),
      title: "XHTML Article",
      loadError: null
    })
    await expect(window.locator("#url_error")).toBeHidden()
  } finally {
    await closeApp(electronApp, userData)
  }
})

test("keeps a reader request on the tab that asked for it", async () => {
  const { electronApp, userData, window } = await launchApp({
    env: { ONCE_ELECTRON_DISABLE_NETWORK_FETCH: "0" }
  })
  try {
    const address = window.locator("#urlfield")
    await address.fill(`${origin}/slow-article`)
    await address.press("Enter")
    // Reader mode is asked for while the page is still on its way, then the
    // user moves to another tab before the article has been extracted.
    await window.locator("#browser_reader").click()
    await expect(window.locator("#browser_reader")).toHaveClass(/pending/)
    const second = await window.evaluate(() =>
      window.onceElectron.tabs.create("about:blank", true))

    await expect.poll(() => window.evaluate(async () =>
      (await window.onceElectron.tabs.getAll()).map((tab) => ({
        url: tab.url,
        active: tab.active,
        loadError: tab.loadError
      }))
    ), { timeout: 15_000 }).toEqual([
      {
        url: readerUrl(`${origin}/slow-article`),
        active: false,
        loadError: null
      },
      { url: "about:blank", active: true, loadError: null }
    ])
    expect(second).toBeTruthy()
    await expect(window.locator("#url_error")).toBeHidden()
  } finally {
    await closeApp(electronApp, userData)
  }
})

test("regenerates a missing reader document from its source URL", async () => {
  const { electronApp, userData, window } = await launchApp({
    env: { ONCE_ELECTRON_DISABLE_NETWORK_FETCH: "0" }
  })
  try {
    const address = window.locator("#urlfield")
    await address.fill(`once-reader://${origin}/article`)
    await address.press("Enter")
    await expect(window.locator(".electron-tab-title")).toHaveText("Regenerated Article")
    await expect(address).toHaveValue(`once-reader://${origin}/article`)
    await expect(window.locator("#url_error")).toBeHidden()
    await expect.poll(() => electronApp.evaluate(async ({ webContents }) => {
      const contents = webContents
        .getAllWebContents()
        .find((candidate) => candidate.getURL().startsWith("once-reader://"))
      if (!contents) return null
      return contents.executeJavaScript(`({
        bodyMaxWidth: getComputedStyle(document.body).maxWidth,
        buttonWidth: getComputedStyle(document.querySelector(".tts-button")).width,
        toolbarPosition: getComputedStyle(document.querySelector(".toolbar")).position
      })`)
    })).toEqual({
      bodyMaxWidth: "700px",
      buttonWidth: "30px",
      toolbarPosition: "sticky"
    })
    await expect.poll(() => electronApp.evaluate(async ({ webContents }) => {
      const contents = webContents
        .getAllWebContents()
        .find((candidate) => candidate.getURL().startsWith("once-reader://"))
      if (!contents) return null
      return contents.executeJavaScript(`(() => {
        const runtime = document.querySelector("script[data-once-reader-runtime]");
        return {
          installed: document.documentElement.dataset.onceTtsInstalled,
          runtimeInline: runtime?.textContent || "",
          runtimeSrc: runtime?.getAttribute("src") || ""
        };
      })()`)
    })).toEqual({
      installed: "true",
      runtimeInline: "",
      runtimeSrc: "once-reader://runtime/reader.js"
    })
    await expect.poll(() => window.evaluate(async () => {
      const active = (await window.onceElectron.tabs.getAll()).find((tab) => tab.active)
      return active && { url: active.url, loadError: active.loadError }
    })).toEqual({
      url: expect.stringMatching(/^once-reader:\/\//),
      loadError: null
    })
  } finally {
    await closeApp(electronApp, userData)
  }
})

test("reader speech remembers the chosen voice and a speed per voice", async () => {
  const launch = (options = {}) => launchApp({ ...options, env: { ONCE_ELECTRON_DISABLE_NETWORK_FETCH: "0" } })
  const launched = await launch()
  const { userData } = launched
  let { electronApp, window } = launched
  // One article's reader document; every article is an origin of its own.
  const inReader = (script, page = "/article") => electronApp.evaluate(async ({ webContents }, { source, page }) => {
    const contents = webContents
      .getAllWebContents()
      .find((candidate) => candidate.getURL().startsWith("once-reader://") && candidate.getURL().endsWith(page))
    if (!contents) return null
    return contents.executeJavaScript(source)
  }, { source: script, page })
  const controls = (page) => inReader(`document.documentElement.dataset.onceTtsInstalled === "true" && ({
    voice: document.querySelector("[data-tts-voice]").value,
    rate: document.querySelector("[data-tts-rate]").value
  })`, page)
  const choose = (selector, value) => inReader(`(() => {
    const control = document.querySelector(${JSON.stringify(selector)});
    control.value = ${JSON.stringify(value)};
    control.dispatchEvent(new Event(control.tagName === "SELECT" ? "change" : "input"));
    control.dispatchEvent(new Event("change"));
  })()`)
  try {
    const address = window.locator("#urlfield")
    await address.fill(`once-reader://${origin}/article`)
    await address.press("Enter")
    await expect.poll(controls).toEqual({ voice: "", rate: "1" })

    await choose("[data-tts-rate]", "2")
    await choose("[data-tts-voice]", "once-wafli-slt")
    // A voice never adjusted starts at the default voice's speed.
    expect(await controls()).toEqual({ voice: "once-wafli-slt", rate: "2" })
    await choose("[data-tts-rate]", "1.5")
    await choose("[data-tts-voice]", "")
    expect(await controls()).toEqual({ voice: "", rate: "2" })
    await choose("[data-tts-voice]", "once-wafli-slt")
    expect(await controls()).toEqual({ voice: "once-wafli-slt", rate: "1.5" })

    await inReader("location.reload()")
    await expect.poll(controls).toEqual({ voice: "once-wafli-slt", rate: "1.5" })

    // Another article is another origin; the settings are the device's, not the origin's.
    await address.fill(`once-reader://${origin}/article.xhtml`)
    await address.press("Enter")
    await expect.poll(() => controls("/article.xhtml")).toEqual({ voice: "once-wafli-slt", rate: "1.5" })

    // They also outlive the app, whose next start gives every document a new token.
    await closeApp(electronApp, userData, { keepUserData: true })
    ;({ electronApp, window } = await launch({ userData, restored: true }))
    // Shell readiness precedes session restoration. Wait for the saved article
    // and its preferences before typing into the restored tab's address bar.
    await expect.poll(() => controls("/article.xhtml"), { timeout: 15_000 })
      .toEqual({ voice: "once-wafli-slt", rate: "1.5" })
    // The restored tab's address can still land in the field after the typed
    // one, and Enter then goes nowhere new: type again until the article opens.
    const field = window.locator("#urlfield")
    await expect(field).toHaveValue(/article\.xhtml/)
    await expect(async () => {
      await field.fill(`once-reader://${origin}/article`)
      await field.press("Enter")
      await expect.poll(() => controls(), { timeout: 5_000 }).not.toBeNull()
    }).toPass({ timeout: 30_000 })
    await expect.poll(() => controls(), { timeout: 15_000 }).toEqual({ voice: "once-wafli-slt", rate: "1.5" })
  } finally {
    await closeApp(electronApp, userData)
  }
})
