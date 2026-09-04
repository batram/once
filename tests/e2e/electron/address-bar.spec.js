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

test("keeps the address synchronized across redirects and page navigation", async () => {
  const { electronApp, userData, window } = await launchApp()
  try {
    const address = window.locator("#urlfield")
    await address.fill(`${origin}/redirect`)
    await address.press("Enter")
    await expect(address).toHaveValue(`${origin}/redirected`)

    // The address bar follows the redirect as soon as the server answers,
    // before the navigation commits, so the page can still report the old URL
    // for a moment; wait for it to have arrived rather than reading it once.
    const findPage = (currentUrl) => electronApp.evaluate(({ webContents }, url) =>
      webContents.getAllWebContents().some((candidate) => candidate.getURL() === url),
    currentUrl)
    await expect.poll(() => findPage(`${origin}/redirected`)).toBe(true)
    await electronApp.evaluate(async ({ webContents }, currentUrl) => {
      const contents = webContents
        .getAllWebContents()
        .find((candidate) => candidate.getURL() === currentUrl)
      if (!contents) throw new Error(`Missing page at ${currentUrl}`)
      await contents.executeJavaScript("document.querySelector('#page-link').click()")
    }, `${origin}/redirected`)

    await expect(address).toHaveValue(`${origin}/linked`)
    await expect.poll(() => window.evaluate(async () => {
      const active = (await window.onceElectron.tabs.getAll()).find((tab) => tab.active)
      return active?.url
    })).toBe(`${origin}/linked`)
  } finally {
    await closeApp(electronApp, userData)
  }
})

test("preserves a failed URL and renders a theme-aware error page", async () => {
  const { electronApp, userData, window } = await launchApp()
  try {
    const failedUrl = "http://127.0.0.1:65534/unreachable"
    const networkFailure = /^ERR_[A-Z_]+ \(-?\d+\)$/
    const address = window.locator("#urlfield")
    await address.fill(failedUrl)
    await address.press("Enter")

    await expect(address).toHaveValue(failedUrl)
    await expect.poll(() => window.evaluate(async () => {
      const active = (await window.onceElectron.tabs.getAll()).find((tab) => tab.active)
      return active && {
        url: active.url,
        error: active.loadError,
        loading: active.loading
      }
    })).toMatchObject({
      url: failedUrl,
      error: expect.stringMatching(networkFailure),
      loading: false
    })

    await expect.poll(() => electronApp.evaluate(async ({ webContents }) => {
      const contents = webContents
        .getAllWebContents()
        .find((candidate) => candidate.getURL().startsWith("once-error://"))
      if (!contents) return null
      return contents.executeJavaScript(`({
        text: document.body.innerText,
        theme: document.documentElement.dataset.theme,
        background: getComputedStyle(document.body).backgroundColor
      })`)
    })).toMatchObject({
      text: expect.stringContaining(failedUrl)
    })

    await window.evaluate(() => window.onceElectron.window.setBackgroundColor("#f6f6ef"))
    await expect.poll(() => electronApp.evaluate(async ({ webContents }) => {
      const contents = webContents
        .getAllWebContents()
        .find((candidate) => candidate.getURL().startsWith("once-error://"))
      if (!contents) return null
      return contents.executeJavaScript(`({
        theme: document.documentElement.dataset.theme,
        background: getComputedStyle(document.body).backgroundColor
      })`)
    })).toEqual({
      theme: "light",
      background: "rgb(246, 246, 239)"
    })

    await window.evaluate(() => window.onceElectron.window.setBackgroundColor("#282a36"))
    await expect.poll(() => electronApp.evaluate(async ({ webContents }) => {
      const contents = webContents
        .getAllWebContents()
        .find((candidate) => candidate.getURL().startsWith("once-error://"))
      if (!contents) return null
      return contents.executeJavaScript(`({
        theme: document.documentElement.dataset.theme,
        background: getComputedStyle(document.body).backgroundColor
      })`)
    })).toEqual({
      theme: "dark",
      background: "rgb(40, 42, 54)"
    })

    await window.locator("#browser_reload").click()
    await expect(address).toHaveValue(failedUrl)
    await expect.poll(() => window.evaluate(async () => {
      const active = (await window.onceElectron.tabs.getAll()).find((tab) => tab.active)
      return active?.loadError
    })).toMatch(networkFailure)

    await address.fill(`${origin}/recovered`)
    await address.press("Enter")
    await expect(address).toHaveValue(`${origin}/recovered`)
    await expect(window.locator(".electron-tab-title")).toHaveText("Recovered")
    await window.locator("#browser_back").click()
    await expect(address).toHaveValue(failedUrl)
    await expect.poll(() => window.evaluate(async () => {
      const active = (await window.onceElectron.tabs.getAll()).find((tab) => tab.active)
      return active && { url: active.url, error: active.loadError }
    })).toMatchObject({
      url: failedUrl,
      error: expect.stringMatching(networkFailure)
    })
  } finally {
    await closeApp(electronApp, userData)
  }
})

test("goes back past a DNS failure to the previous page", async () => {
  const { electronApp, userData, window } = await launchApp()
  try {
    const address = window.locator("#urlfield")
    const enteredUrl = "this-domain-does-not-exist.invalid"
    const failedUrl = "https://this-domain-does-not-exist.invalid/"

    await address.fill(`${origin}/before-dns-failure`)
    await address.press("Enter")
    await expect(window.locator(".electron-tab-title")).toHaveText("Before-dns-failure")

    await address.fill(enteredUrl)
    await address.press("Enter")
    await expect(address).toHaveValue(failedUrl)
    await expect.poll(() => window.evaluate(async () => {
      const active = (await window.onceElectron.tabs.getAll()).find((tab) => tab.active)
      return active?.loadError
    })).toContain("ERR_NAME_NOT_RESOLVED")

    await window.locator("#browser_back").click()
    await expect(address).toHaveValue(`${origin}/before-dns-failure`)
    await expect(window.locator(".electron-tab-title")).toHaveText("Before-dns-failure")
  } finally {
    await closeApp(electronApp, userData)
  }
})
