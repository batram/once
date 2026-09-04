const { expect, _electron: electron } = require("@playwright/test")
const fs = require("node:fs/promises")
const http = require("node:http")
const os = require("node:os")
const path = require("node:path")
const storyFixture = require("../shared/story-fixture")

const ARTICLE_PARAGRAPH =
  "The reader pipeline extracts long-form content from ordinary pages. " +
  "This paragraph exists so the readability heuristics find enough article text to accept the page. " +
  "It repeats a few times to comfortably clear the extraction thresholds used by the application."

function articlePage(title) {
  return `<!doctype html>
        <title>${title}</title>
        <article>
          <h1>${title}</h1>
          <p>${ARTICLE_PARAGRAPH}</p>
          <p>${ARTICLE_PARAGRAPH}</p>
          <p>${ARTICLE_PARAGRAPH}</p>
        </article>`
}

function xhtmlArticlePage(title) {
  return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>${title}</title></head>
  <body>
    <article>
      <h1>${title}</h1>
      <p>${ARTICLE_PARAGRAPH}</p>
      <p>${ARTICLE_PARAGRAPH}</p>
      <p>${ARTICLE_PARAGRAPH}</p>
      <hr/>
    </article>
  </body>
</html>`
}

const { ADDON_SCRIPT, addonApiStories, addonPackageManifest } = require("../shared/addon-fixture")

// The scripts the extension and add-on specs install: a scripted Once add-on
// (its manifest pins this exact text by hash, so specs compute the integrity
// from ADDON_SCRIPT) and a userscript served the way script hosts serve them,
// which is what makes Violentmonkey open its install page.
function serveFixtureScript(request, response, origin) {
  if (request.url === "/addon/main.js") {
    response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" })
    response.end(ADDON_SCRIPT)
    return true
  }
  if (request.url === "/addon/once-addon.json") {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" })
    response.end(JSON.stringify(addonPackageManifest()))
    return true
  }
  // The feed the fixture add-on's collector reads.
  if (request.url === "/api/stories.json") {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" })
    response.end(JSON.stringify(addonApiStories(origin)))
    return true
  }
  if (request.url === "/once-test.user.js") {
    response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" })
    response.end(`// ==UserScript==
// @name        Once Harness Script
// @namespace   once-e2e
// @version     1.0
// @description Marks pages it runs on.
// @match       ${origin}/*
// @grant       none
// ==/UserScript==
document.documentElement.dataset.onceHarnessScript = "ran"
`)
    return true
  }
  return false
}

// A page whose CSP allows no frames but its own, on a light background: what
// uBlock's element picker meets on sites such as Hacker News. The picker dims
// the page by half, so the text has to stay readable through it.
const STRICT_FRAMES_PAGE = `<!doctype html>
<title>Strict frames</title>
<style>
  body { background: #ffffff; color: #111111; font: 16px system-ui; margin: 0; padding: 24px; }
  #advert { background: #ffe08a; padding: 16px; }
</style>
<p id="advert">An advert to pick</p>
<p>Body text the picker overlay must not hide.</p>`

async function startPageServer(options = {}) {
  let origin = ""
  const server = http.createServer((request, response) => {
    if (typeof options.onRequest === "function") {
      const startedAt = Date.now()
      const requestDetails = {
        method: request.method || "GET",
        url: request.url || "",
        host: request.headers.host || "",
        remoteAddress: request.socket.remoteAddress || ""
      }
      const observe = (details) => {
        try {
          options.onRequest({ ...requestDetails, ...details })
        } catch (error) {
          console.error("Electron fixture request observer failed", error)
        }
      }

      observe({ phase: "request" })
      response.on("finish", () => {
        observe({
          phase: "response",
          statusCode: response.statusCode,
          durationMs: Date.now() - startedAt
        })
      })
      response.on("close", () => {
        if (!response.writableFinished) {
          observe({
            phase: "response-closed",
            statusCode: response.statusCode,
            durationMs: Date.now() - startedAt
          })
        }
      })
      request.on("aborted", () => {
        observe({
          phase: "request-aborted",
          durationMs: Date.now() - startedAt
        })
      })
      request.on("error", (error) => {
        observe({
          phase: "request-error",
          durationMs: Date.now() - startedAt,
          error: error.message
        })
      })
      response.on("error", (error) => {
        observe({
          phase: "response-error",
          durationMs: Date.now() - startedAt,
          error: error.message
        })
      })
      request.socket.once("error", (error) => {
        observe({
          phase: "socket-error",
          durationMs: Date.now() - startedAt,
          error: error.message
        })
      })
      request.socket.once("close", (hadError) => {
        observe({
          phase: "socket-closed",
          durationMs: Date.now() - startedAt,
          hadError
        })
      })
    }

    if (storyFixture.handleRequest(request, response, origin)) {
      return
    }
    if (serveFixtureScript(request, response, origin)) {
      return
    }
    if (request.url === "/redirect") {
      response.writeHead(302, { location: `${origin}/redirected` })
      response.end()
      return
    }
    if (request.url === "/strict-frames") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "frame-src 'self'; child-src 'self'"
      })
      response.end(STRICT_FRAMES_PAGE)
      return
    }
    if (request.url === "/video") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      response.end(`<!doctype html>
        <title>Fullscreen video</title>
        <style>
          body { margin: 0; background: #111; }
          iframe { width: 700px; height: 440px; border: 0; }
        </style>
        <iframe id="player-frame" src="${origin}/video-player" allow="fullscreen"></iframe>`)
      return
    }
    if (request.url === "/article") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      response.end(articlePage("Regenerated Article"))
      return
    }
    // Served the way sites such as build2.org serve their posts: an XML media
    // type the reader has to accept and parse as XML.
    if (request.url === "/article.xhtml") {
      response.writeHead(200, { "content-type": "application/xhtml+xml" })
      response.end(xhtmlArticlePage("XHTML Article"))
      return
    }
    // Arrives slowly enough that the tab is still loading when a test reaches
    // for reader mode.
    if (request.url === "/slow-article") {
      setTimeout(() => {
        if (response.writableEnded) return
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
        response.end(articlePage("Slow Article"))
      }, 1500)
      return
    }
    if (request.url === "/stories") {
      const stories = ["One", "Two", "Three"].map((name) => `
        <li class="story">
          <h2><a class="title" href="${origin}/${name.toLowerCase()}">Story ${name}</a></h2>
          <span class="tag">tag-${name.toLowerCase()}</span>
        </li>`).join("")
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      response.end(`<!doctype html>
        <title>Stories</title>
        <main>
          <h1>Story list</h1>
          <ul class="stories">${stories}</ul>
        </main>`)
      return
    }
    if (request.url === "/video-player") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      response.end(`<!doctype html>
        <title>Embedded player</title>
        <style>
          body { margin: 0; background: #111; color: white; }
          video { display: block; width: 640px; height: 360px; background: #222; }
          button { margin: 16px; padding: 12px; }
        </style>
        <button id="enter-fullscreen" type="button">Enter video fullscreen</button>
        <video id="test-video" controls></video>
        <script>
          document.querySelector("#enter-fullscreen").addEventListener("click", () => {
            document.querySelector("#test-video").requestFullscreen()
          })
        </script>`)
      return
    }
    const name = request.url.slice(1) || "one"
    const title = name.charAt(0).toUpperCase() + name.slice(1)
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    response.end(`<!doctype html>
      <title>${title}</title>
      <h1>${title}</h1>
      <a id="page-link" href="${origin}/linked">Linked page</a>
      <input id="page-input" value="editable" />`)
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  origin = `http://127.0.0.1:${server.address().port}`
  return {
    origin,
    close: () => new Promise((resolve) => server.close(resolve))
  }
}

async function launchApp(options = {}) {
  // Reusing an existing userData dir relaunches the app on the same profile
  // (persistence tests); otherwise every launch gets a fresh temp profile.
  const userData =
    options.userData ||
    (await fs.mkdtemp(path.join(os.tmpdir(), "once-electron-test-")))
  const appRoot = options.appRoot || path.resolve(__dirname, "../../..")
  // Electron 43+ downloads its development binary lazily when the package is required,
  // so do not hard-code node_modules/electron/dist/electron.exe after a clean npm ci.
  const executablePath = require(path.join(appRoot, "node_modules", "electron"))
  const appPath = path.join(
    appRoot,
    "apps",
    "electron",
    ".webpack",
    process.arch,
    "main",
    "index.js"
  )
  // Windows launch non-focusable by default so a test run never steals OS focus
  // from whatever the developer is doing; Playwright drives the app through CDP
  // and sendInputEvent, neither of which needs an activated window. Pass
  // background: false, or set ONCE_ELECTRON_E2E_INTERACTIVE=1 for the whole run,
  // when you want to watch and click the app yourself.
  const background =
    options.background !== false && process.env.ONCE_ELECTRON_E2E_INTERACTIVE !== "1"
  const electronApp = await electron.launch({
    executablePath,
    args: [appPath],
    env: {
      ...process.env,
      ONCE_ELECTRON_TEST_USER_DATA: userData,
      ONCE_ELECTRON_DISABLE_STORY_LOADING: "1",
      ONCE_ELECTRON_DISABLE_NETWORK_FETCH: "1",
      ...(background ? { ONCE_ELECTRON_TEST_BACKGROUND: "1" } : {}),
      ...options.env
    }
  })
  await expect.poll(() => electronApp.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().length
  ), { timeout: 10_000 }).toBe(1)
  const window = await electronApp.firstWindow()
  await expect(window.locator("body")).toHaveAttribute(
    "data-once-ready",
    "true",
    { timeout: 7_000 }
  )
  await expect.poll(() => window.evaluate(() => window.onceElectron.tabs.getAll()))
    .toMatchObject([{ url: "about:blank", active: true }])
  return { electronApp, userData, window }
}

async function closeApp(electronApp, userData, { keepUserData = false } = {}) {
  await electronApp.close()
  if (!keepUserData) {
    await fs.rm(userData, { recursive: true, force: true })
  }
}

async function expectDocumentFocus(locator) {
  await expect.poll(() => locator.evaluate(
    (element) => document.activeElement === element
  )).toBe(true)
}

async function openPanel(window, panel) {
  const control = window.getByTestId(`${panel}-menu`)
  await expect(control).toBeVisible()
  await control.click()
  await expect(window.locator("#left_panel")).toHaveAttribute(
    "active_panel",
    panel
  )
  await expect(window.locator(`#${panel}_panel`)).toBeVisible()
}

async function openSettingsSection(window, target, controlSelector) {
  await openPanel(window, "settings")
  const row = window.locator(`[data-settings-target="${target}"]`)
  if (!(await row.isVisible())) {
    const back = window.locator("#settings_section_back")
    await expect(
      back,
      "settings index was hidden but its back button was not visible"
    ).toBeVisible({ timeout: 5_000 })
    await back.click()
  }
  await row.click({
    timeout: 5_000
  })
  const section = window.locator(
    `.settings_section[data-settings-section="${target}"]`
  )
  await expect(section, `${target} settings section did not open`).toBeVisible({
    timeout: 5_000
  })
  if (!controlSelector) return section
  const control = section.locator(controlSelector)
  if (!(await control.isVisible()) &&
      ["sources", "filters", "redirects"].includes(target)) {
    await window.getByTestId(`${target}-mode-toggle`).click()
  }
  await expect(
    control,
    `${target} settings control ${controlSelector} was not visible`
  ).toBeVisible({ timeout: 5_000 })
  return control
}

async function showAllStories(window) {
  await openPanel(window, "stories")
  const search = window.locator("#searchfield")
  await search.fill("")
  await expect(search).toHaveValue("")
  const stories = window.locator("#stories")
  await expect(stories).toBeVisible()
  await expect(stories).not.toHaveClass(/\bshow_filtered\b/)
}

// Seed through settings and wait for the exact fixture story before continuing.
async function seedLocalSource(window, sourceLine, expectedStoryHref) {
  if (!expectedStoryHref) {
    throw new Error("seedLocalSource requires an expected fixture story URL")
  }
  const animation = await openSettingsSection(
    window,
    "theme",
    "#anim_checkbox"
  )
  await animation.uncheck()
  await expect(window.locator("body")).toHaveAttribute("animated", "false")
  const sources = await openSettingsSection(
    window,
    "sources",
    '[data-testid="sources"]'
  )
  // This is fixture setup, not an editor interaction under test. Setting the
  // value directly avoids Electron text-focus/input handling, which can hang
  // in the non-interactive Windows session used by GitHub-hosted runners.
  await sources.evaluate((textarea, value) => {
    textarea.value = value
  }, sourceLine)
  await expect(sources).toHaveValue(sourceLine)
  await window.getByTestId("save-sources").evaluate((button) => button.click())
  await showAllStories(window)
  await expect(
    window.locator(`#stories story-item[data-href="${expectedStoryHref}"]`)
  ).toBeVisible({ timeout: 10_000 })
}

async function saveFilters(window, text) {
  const filters = await openSettingsSection(
    window,
    "filters",
    '[data-testid="filters"]'
  )
  await filters.fill(text)
  await window.getByTestId("save-filters").click()
  await showAllStories(window)
}

async function saveRedirects(window, text) {
  const redirects = await openSettingsSection(
    window,
    "redirects",
    '[data-testid="redirects"]'
  )
  await redirects.fill(text)
  await window.getByTestId("save-redirects").click()
  await showAllStories(window)
}

// The default redirect list has held a single rule since the Nitter rule
// went, and the structured editor specs need a second row: one to drag, one
// to drop onto, and a row that survives while its neighbour is being edited.
// Leaves the redirects section open in structured mode.
const SEEDED_REDIRECTS = [
  "https:\\/\\/www.reddit.com\\/(.*) => https://old.reddit.com/$1",
  "https:\\/\\/example.test\\/(.*) => https://example.org/$1"
].join("\n")

async function seedRedirects(window) {
  await saveRedirects(window, SEEDED_REDIRECTS)
  await openSettingsSection(
    window,
    "redirects",
    '[data-structured-section="redirects"] .structured_row >> nth=0'
  )
  await expect(
    window.locator('[data-structured-section="redirects"] .structured_row')
  ).toHaveCount(2)
}

async function getWindowTabs(electronApp, windowId) {
  return electronApp.evaluate(async ({ BrowserWindow }, id) => {
    const target = BrowserWindow.fromId(id)
    if (!target) throw new Error(`Missing BrowserWindow ${id}`)
    return target.webContents.executeJavaScript("window.onceElectron.tabs.getAll()")
  }, windowId)
}

async function getOnceWindows(electronApp) {
  return electronApp.evaluate(async ({ BrowserWindow }) =>
    Promise.all(BrowserWindow.getAllWindows().map(async (candidate) => ({
      id: candidate.id,
      tabs: await candidate.webContents.executeJavaScript("window.onceElectron.tabs.getAll()")
    })))
  )
}

async function markLiveContents(electronApp, url) {
  return electronApp.evaluate(async ({ webContents }, targetUrl) => {
    const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === targetUrl)
    if (!contents) throw new Error(`Missing webContents for ${targetUrl}`)
    await contents.executeJavaScript("window.__onceE2EState = 42")
    return contents.id
  }, url)
}

async function getLiveContentsState(electronApp, contentsId) {
  return electronApp.evaluate(async ({ webContents }, id) => {
    const contents = webContents.fromId(id)
    if (!contents || contents.isDestroyed()) return null
    return {
      url: contents.getURL(),
      state: await contents.executeJavaScript("window.__onceE2EState")
    }
  }, contentsId)
}

async function transferTab(electronApp, windowId, action, tabId) {
  if (action !== "detach" && action !== "moveHere") {
    throw new Error(`Unsupported tab transfer: ${action}`)
  }
  return electronApp.evaluate(async ({ BrowserWindow }, request) => {
    const target = BrowserWindow.fromId(request.windowId)
    if (!target) throw new Error(`Missing BrowserWindow ${request.windowId}`)
    const script = `window.onceElectron.tabs[${JSON.stringify(request.action)}](${JSON.stringify(request.tabId)})`
    await target.webContents.executeJavaScript(script)
  }, { windowId, action, tabId })
}

module.exports = {
  ADDON_SCRIPT,
  closeApp,
  expectDocumentFocus,
  getLiveContentsState,
  getOnceWindows,
  getWindowTabs,
  launchApp,
  markLiveContents,
  openPanel,
  openSettingsSection,
  saveFilters,
  saveRedirects,
  seedLocalSource,
  seedRedirects,
  showAllStories,
  startPageServer,
  transferTab
}
