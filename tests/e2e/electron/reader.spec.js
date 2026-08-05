const { test, expect } = require("@playwright/test")
const { closeApp, launchApp, startPageServer } = require("./electron-harness")

let pageServer
let origin

test.beforeAll(async () => {
  pageServer = await startPageServer()
  origin = pageServer.origin
})

test.afterAll(async () => {
  await pageServer.close()
})

// Chromium parses once-reader:// as a standard scheme, so the source URL's own
// scheme colon is dropped once the tab has navigated. The address bar still
// shows the readable form.
function readerUrl(sourceUrl) {
  return `once-reader://${sourceUrl.replace("://", "//")}`
}

test("duplicates a reader tab into a second reader tab", async () => {
  const { electronApp, userData, window } = await launchApp()
  try {
    await window.evaluate(({ html, sourceUrl }) =>
      window.onceElectron.tabs.openReader(html, sourceUrl, "_self"),
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
    await expect(window.locator(".electron-tab-title").nth(2)).toHaveText("Failed to load")
    await expect(address).toHaveValue("once-reader://https://example.com/never-opened")
    await expect.poll(() => window.evaluate(async () => {
      const active = (await window.onceElectron.tabs.getAll()).find((tab) => tab.active)
      return active?.loadError
    })).toContain("Reader mode failed: Network fetches are disabled")
    await expect.poll(() => electronApp.evaluate(async ({ webContents }) => {
      const contents = webContents
        .getAllWebContents()
        .find((candidate) => candidate.getURL().startsWith("once-error://"))
      if (!contents) return null
      return contents.executeJavaScript(`({
        text: document.body.innerText,
        retryCount: document.querySelectorAll(".retry").length
      })`)
    })).toEqual({
      text: expect.stringContaining("Reader mode failed: Network fetches are disabled"),
      retryCount: 1
    })
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
      return contents.executeJavaScript(`(async () => {
        const errors = [];
        window.addEventListener("error", (event) => errors.push(event.message), { once: true });
        const source = document.querySelector("script").textContent;
        const parseError = (() => {
          try {
            Function(source)
            return null
          } catch (error) {
            return error.message
          }
        })();
        const engine = window.speechSynthesis || {};
        for (const [name, implementation] of Object.entries({
          addEventListener() {},
          cancel() {},
          getVoices() { return []; },
          pause() {},
          resume() {},
          speak() {}
        })) {
          Object.defineProperty(engine, name, {
            configurable: true,
            value: implementation
          });
        }
        Object.defineProperty(window, "speechSynthesis", {
          configurable: true,
          value: engine
        });
        Object.defineProperty(window, "SpeechSynthesisUtterance", {
          configurable: true,
          value: class {
            constructor(text) { this.text = text; }
          }
        });
        delete document.documentElement.dataset.onceTtsInstalled;
        document.querySelectorAll(".tts-controls :disabled").forEach((control) => {
          control.disabled = false;
        });
        document.querySelector('[data-testid="tts-unavailable"]')?.remove();
        Function(source)();
        const play = document.querySelector("[data-tts-play]");
        play.click();
        await new Promise((resolve) => setTimeout(resolve, 100));
        return {
          errors,
          installed: document.documentElement.dataset.onceTtsInstalled,
          parseError
        };
      })()`)
    })).toEqual({
      errors: [],
      installed: "true",
      parseError: null
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
