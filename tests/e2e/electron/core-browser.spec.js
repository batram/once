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

test("launches a secure browser shell with legacy tab interactions", async () => {
  const { electronApp, userData, window } = await launchApp()
  try {
    await expect(window.locator("#right_panel")).toBeVisible()
    await expect(window.locator(".electron-tab")).toHaveCount(1)
    await expect(window.getByTestId("app-version")).toHaveText(
      await electronApp.evaluate(({ app }) => app.getVersion())
    )
    await window.getByTestId("settings-menu").click()
    const updateButton = window.getByTestId("check-for-updates")
    await expect(updateButton).toBeVisible()
    await expect(updateButton).toBeDisabled()
    await expect(updateButton).toHaveAttribute(
      "title",
      "Updates are available in installed release builds."
    )
    await expect(window.getByTestId("update-status")).toHaveText(
      "Updates are available in installed release builds."
    )
    expect(await window.evaluate(() => window.onceElectron.app.checkForUpdates()))
      .toEqual({
        state: "disabled",
        message: "Updates are available in installed release builds."
      })
    await window.getByTestId("stories-menu").click()

    await expect(window.locator(".electron-tab")).toHaveCSS("min-width", "140px")
    await expect(window.locator(".electron-tab")).toHaveCSS(
      "border-radius",
      "2px 2px 0px 0px"
    )
    await expect(window.locator(".electron-tab-close")).toHaveCSS("opacity", "0")

    const controlBoxes = await window.evaluate(() =>
      [
        "browser_back",
        "browser_forward",
        "urlfield",
        "browser_reload",
        "browser_close"
      ].map((id) => {
        const rect = document.getElementById(id).getBoundingClientRect()
        return { top: Math.round(rect.top), height: Math.round(rect.height) }
      })
    )
    expect(new Set(controlBoxes.map((box) => box.top)).size).toBe(1)
    expect(new Set(controlBoxes.map((box) => box.height))).toEqual(new Set([26]))
    await expect(window.locator("#browser_back svg")).toHaveCount(1)
    await expect(window.locator("#browser_forward svg")).toHaveCount(1)

    const address = window.locator("#urlfield")
    await address.fill("not a valid URL")
    await address.press("Enter")
    await expect(address).toHaveValue("not a valid URL")
    await expect(window.locator("#url_error")).toBeHidden()
    await expect(window.locator(".electron-tab-title")).toHaveText("Failed to load")
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
      text: expect.stringContaining("Enter a complete HTTP or HTTPS URL"),
      retryCount: 0
    })

    await address.fill(`${origin}/one`)
    await address.press("Enter")
    await expect(address).toHaveValue(`${origin}/one`)

    await window.evaluate(
      (url) => window.onceElectron.tabs.openUrl(url, "middle"),
      `${origin}/two`
    )
    await expect(window.locator(".electron-tab")).toHaveCount(2)
    await expect(address).toHaveValue(`${origin}/one`)

    await expect
      .poll(() =>
        electronApp.evaluate(async ({ webContents }, expectedUrl) => {
          const remote = webContents
            .getAllWebContents()
            .find((contents) => contents.getURL() === expectedUrl)
          if (!remote) return null
          return remote.executeJavaScript(`({
            requireType: typeof require,
            processType: typeof process,
            bridgeType: typeof window.onceElectron
          })`)
        }, `${origin}/two`)
      )
      .toEqual({
        requireType: "undefined",
        processType: "undefined",
        bridgeType: "undefined"
      })

    const ids = await window.evaluate(() => window.onceElectron.tabs.getAll())
    await window.evaluate(
      ({ id, beforeId }) => window.onceElectron.tabs.reorder(id, beforeId),
      { id: ids[1].id, beforeId: ids[0].id }
    )
    await expect(window.locator(".electron-tab-title").first()).toHaveText("Two")

    await window.locator(".electron-tab").first().dispatchEvent("auxclick", {
      button: 1
    })
    await expect(window.locator(".electron-tab")).toHaveCount(1)

    await window.locator("#tab_dropzone").evaluate((element, url) => {
      document.querySelector("#urlfield").blur()
      const transfer = new DataTransfer()
      transfer.setData("text/uri-list", url)
      element.dispatchEvent(
        new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer
        })
      )
    }, `${origin}/dropped`)
    await expect(window.locator(".electron-tab")).toHaveCount(2)
    await expect(address).toHaveValue(`${origin}/dropped`)

    await window.locator(".electron-tab").last().hover()
    await expect(window.locator(".electron-tab-close").last()).toHaveCSS(
      "opacity",
      "1"
    )
  } finally {
    await closeApp(electronApp, userData)
  }
})

test("keeps the icon rail and restores either sidebar panel", async () => {
  const { electronApp, userData, window } = await launchApp()
  try {
    const collapse = window.locator("#stories_panel .collapsebutton")
    const dividerGap = await window.evaluate(() => {
      const button = document
        .querySelector("#stories_panel .collapsebutton")
        .getBoundingClientRect()
      const divider = document.querySelector("#sep_slider").getBoundingClientRect()
      return Math.round(divider.left - button.right)
    })
    expect(dividerGap).toBe(0)

    await collapse.click()
    await expect(window.locator("#left_panel")).toBeVisible()
    await expect(window.locator("#left_main")).toBeHidden()
    await expect(window.locator("#menu")).toBeVisible()
    await expect(window.locator("#menu")).toHaveClass(/\bcollapse\b/)
    await expect(window.locator("#left_panel")).toHaveCSS("width", "30px")
    await expect(window.locator("#browser_sidebar_toggle")).toHaveCount(0)

    await window.getByTestId("settings-menu").click()
    await expect(window.locator("#left_main")).toBeVisible()
    await expect(window.locator("#menu")).not.toHaveClass(/\bcollapse\b/)
    await expect(window.locator("#left_panel")).toHaveAttribute(
      "active_panel",
      "settings"
    )

    await window.locator("#settings_panel .collapsebutton").click()
    await expect(window.locator("#left_main")).toBeHidden()
    await window.getByTestId("stories-menu").click()
    await expect(window.locator("#left_main")).toBeVisible()
    await expect(window.locator("#left_panel")).toHaveAttribute(
      "active_panel",
      "stories"
    )
  } finally {
    await closeApp(electronApp, userData)
  }
})

test("clears a stale tab title when the next page has no title", async () => {
  const { electronApp, userData, window } = await launchApp()
  try {
    const address = window.locator("#urlfield")
    const title = window.locator(".electron-tab-title")

    await address.fill(`${origin}/titled`)
    await address.press("Enter")
    await expect(title).toHaveText("Titled")

    await address.fill("about:blank")
    await address.press("Enter")
    await expect(title).toHaveText("New tab")

    await address.fill(`${origin}/titled-again`)
    await address.press("Enter")
    await expect(title).toHaveText("Titled-again")

    await address.fill("http://127.0.0.1:1/unreachable")
    await address.press("Enter")
    await expect(title).toHaveText("New tab")
  } finally {
    await closeApp(electronApp, userData)
  }
})

test("keeps the address synchronized across redirects and page navigation", async () => {
  const { electronApp, userData, window } = await launchApp()
  try {
    const address = window.locator("#urlfield")
    await address.fill(`${origin}/redirect`)
    await address.press("Enter")
    await expect(address).toHaveValue(`${origin}/redirected`)

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

    const nativeBackTarget = await electronApp.evaluate(({ webContents }) => {
      const contents = webContents
        .getAllWebContents()
        .find((candidate) => candidate.getURL().startsWith("once-error://"))
      if (!contents) throw new Error("Missing error page web contents")
      const history = contents.navigationHistory
      const target = history.getEntryAtIndex(history.getActiveIndex() - 1)?.url
      history.goBack()
      return target
    })
    expect(nativeBackTarget).toBe(`${origin}/before-dns-failure`)
    await expect(address).toHaveValue(`${origin}/before-dns-failure`)
    await expect(window.locator(".electron-tab-title")).toHaveText("Before-dns-failure")
  } finally {
    await closeApp(electronApp, userData)
  }
})
