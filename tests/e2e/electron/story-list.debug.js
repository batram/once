const { test, expect } = require("@playwright/test")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const {
  closeApp,
  launchApp,
  openSettingsSection,
  startPageServer
} = require("./electron-harness")
const storyFixture = require("../shared/story-fixture")

const STORY_ENV = {
  env: {
    ELECTRON_ENABLE_LOGGING: "1",
    ELECTRON_ENABLE_STACK_DUMPING: "1",
    ONCE_ELECTRON_DISABLE_NETWORK_FETCH: "0"
  }
}
const OPERATION_TIMEOUT = 5_000

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function serializeError(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack || ""
    }
  }
  return { message: String(error) }
}

function safeName(value) {
  return value.replace(/[^a-z0-9-]+/gi, "-").replace(/^-|-$/g, "")
}

function createDiagnosticLog(testInfo) {
  const startedAt = Date.now()
  const logPath = testInfo.outputPath("diagnostics.ndjson")
  fs.mkdirSync(path.dirname(logPath), { recursive: true })

  const write = (event, details = {}) => {
    const entry = {
      timestamp: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
      event,
      details
    }
    fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`, "utf8")
    const serializedDetails = JSON.stringify(details)
    const consoleDetails =
      serializedDetails.length > 4_000
        ? `${serializedDetails.slice(0, 4_000)}… (${serializedDetails.length} chars; full details in diagnostics.ndjson)`
        : serializedDetails
    console.log(
      `[story-debug +${entry.elapsedMs}ms] ${event} ${consoleDetails}`
    )
  }

  return { logPath, write }
}

async function bounded(label, action, timeout = OPERATION_TIMEOUT) {
  let timeoutId
  try {
    return await Promise.race([
      action(),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`${label} exceeded ${timeout}ms`))
        }, timeout)
      })
    ])
  } finally {
    clearTimeout(timeoutId)
  }
}

function attachRuntimeListeners(electronApp, window, write) {
  const child = electronApp.process()
  write("electron-process", {
    pid: child.pid || null,
    stdoutAvailable: Boolean(child.stdout),
    stderrAvailable: Boolean(child.stderr)
  })

  const pipeProcessOutput = (streamName, stream) => {
    if (!stream) return
    stream.setEncoding("utf8")
    stream.on("data", (chunk) => {
      write(`electron-${streamName}`, {
        text: String(chunk).slice(0, 20_000)
      })
    })
  }
  pipeProcessOutput("stdout", child.stdout)
  pipeProcessOutput("stderr", child.stderr)
  child.on("exit", (code, signal) => {
    write("electron-exit", { code, signal })
  })
  child.on("error", (error) => {
    write("electron-process-error", serializeError(error))
  })

  window.on("console", (message) => {
    write("renderer-console", {
      type: message.type(),
      text: message.text(),
      location: message.location()
    })
  })
  window.on("pageerror", (error) => {
    write("renderer-page-error", serializeError(error))
  })
  window.on("crash", () => {
    write("renderer-crash")
  })
  window.on("close", () => {
    write("renderer-close")
  })
  window.on("request", (request) => {
    write("renderer-request", {
      method: request.method(),
      resourceType: request.resourceType(),
      url: request.url()
    })
  })
  window.on("response", (response) => {
    write("renderer-response", {
      status: response.status(),
      url: response.url()
    })
  })
  window.on("requestfailed", (request) => {
    write("renderer-request-failed", {
      method: request.method(),
      resourceType: request.resourceType(),
      url: request.url(),
      failure: request.failure()
    })
  })
}

async function rendererSnapshot(window) {
  return window.evaluate(() => {
    const describeElement = (element) => {
      if (!element) return null
      const rect = element.getBoundingClientRect()
      return {
        tagName: element.tagName,
        id: element.id || "",
        className: String(element.className || ""),
        text: (element.textContent || "").trim().slice(0, 1_000),
        rect: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height
        }
      }
    }
    const storyElements = Array.from(
      document.querySelectorAll("#stories story-item")
    )

    return {
      location: window.location.href,
      readyState: document.readyState,
      visibilityState: document.visibilityState,
      hasFocus: document.hasFocus(),
      activeElement: describeElement(document.activeElement),
      bodyAnimated: document.body.getAttribute("animated"),
      settingsPanel: describeElement(document.querySelector("#settings_panel")),
      storiesPanel: describeElement(document.querySelector("#stories_panel")),
      sourcesValue: document.querySelector("#sources_area")?.value || "",
      searchValue: document.querySelector("#searchfield")?.value || "",
      loaderText: document.querySelector("#status_bar_text")?.textContent || "",
      status: {
        kind: document.querySelector("#status_bar")?.dataset.kind || "",
        text: document.querySelector("#status_bar_text")?.textContent || "",
        title: document.querySelector("#status_bar_message")?.title || "",
        warnings:
          document.querySelector("#status_bar_warnings")?.textContent || "",
        errors: document.querySelector("#status_bar_errors")?.textContent || ""
      },
      stories: storyElements.map((element) => {
        const rect = element.getBoundingClientRect()
        return {
          href: element.dataset.href || "",
          title: element.querySelector("a.title")?.textContent || "",
          classes: Array.from(element.classList),
          revision: element.story?._rev || null,
          connected: element.isConnected,
          rect: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height
          }
        }
      }),
      storiesHtml:
        document.querySelector("#stories")?.outerHTML.slice(0, 30_000) || ""
    }
  })
}

async function mainProcessSnapshot(electronApp) {
  return electronApp.evaluate(({ app, BrowserWindow, webContents }) => ({
    app: {
      version: app.getVersion(),
      appPath: app.getAppPath(),
      userData: app.getPath("userData"),
      isReady: app.isReady()
    },
    process: {
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
      versions: process.versions,
      env: {
        ONCE_ELECTRON_TEST_USER_DATA:
          process.env.ONCE_ELECTRON_TEST_USER_DATA || "",
        ONCE_ELECTRON_DISABLE_STORY_LOADING:
          process.env.ONCE_ELECTRON_DISABLE_STORY_LOADING || "",
        ONCE_ELECTRON_DISABLE_NETWORK_FETCH:
          process.env.ONCE_ELECTRON_DISABLE_NETWORK_FETCH || "",
        ELECTRON_ENABLE_LOGGING:
          process.env.ELECTRON_ENABLE_LOGGING || "",
        ELECTRON_ENABLE_STACK_DUMPING:
          process.env.ELECTRON_ENABLE_STACK_DUMPING || ""
      }
    },
    windows: BrowserWindow.getAllWindows().map((candidate) => ({
      id: candidate.id,
      title: candidate.getTitle(),
      bounds: candidate.getBounds(),
      visible: candidate.isVisible(),
      focused: candidate.isFocused(),
      minimized: candidate.isMinimized(),
      destroyed: candidate.isDestroyed(),
      webContentsId: candidate.webContents.id,
      url: candidate.webContents.getURL()
    })),
    webContents: webContents.getAllWebContents().map((candidate) => ({
      id: candidate.id,
      type: candidate.getType(),
      url: candidate.getURL(),
      title: candidate.getTitle(),
      loading: candidate.isLoading(),
      loadingMainFrame: candidate.isLoadingMainFrame(),
      crashed: candidate.isCrashed(),
      destroyed: candidate.isDestroyed(),
      osProcessId: candidate.getOSProcessId()
    }))
  }))
}

function diagnosticHelpers(testInfo, electronApp, window, write) {
  const captureCheckpoint = async (label) => {
    const filename = safeName(label)
    const snapshot = { label }

    try {
      snapshot.renderer = await bounded(
        `${label} renderer snapshot`,
        () => rendererSnapshot(window),
        3_000
      )
    } catch (error) {
      snapshot.rendererError = serializeError(error)
    }
    try {
      snapshot.main = await bounded(
        `${label} main-process snapshot`,
        () => mainProcessSnapshot(electronApp),
        3_000
      )
    } catch (error) {
      snapshot.mainError = serializeError(error)
    }

    write("checkpoint", snapshot)
    const jsonPath = testInfo.outputPath(`${filename}.json`)
    fs.writeFileSync(jsonPath, JSON.stringify(snapshot, null, 2), "utf8")
    await testInfo.attach(`${filename}-state`, {
      path: jsonPath,
      contentType: "application/json"
    })

    const screenshotPath = testInfo.outputPath(`${filename}.png`)
    try {
      await bounded(
        `${label} screenshot`,
        () => window.screenshot({ path: screenshotPath, fullPage: true }),
        5_000
      )
      await testInfo.attach(`${filename}-screenshot`, {
        path: screenshotPath,
        contentType: "image/png"
      })
      write("screenshot", { label, path: screenshotPath })
    } catch (error) {
      write("screenshot-error", { label, error: serializeError(error) })
    }
  }

  const runStep = async (label, action, captureAfter = true) => {
    const startedAt = Date.now()
    write("step-start", { label })
    try {
      const result = await action()
      write("step-complete", {
        label,
        durationMs: Date.now() - startedAt
      })
      if (captureAfter) await captureCheckpoint(`after-${label}`)
      return result
    } catch (error) {
      write("step-error", {
        label,
        durationMs: Date.now() - startedAt,
        error: serializeError(error)
      })
      await captureCheckpoint(`${label}-failed`)
      throw error
    }
  }

  const captureTarget = async (label, locator) => {
    const details = await bounded(`${label} target inspection`, () =>
      locator.evaluate((element) => {
        const rect = element.getBoundingClientRect()
        const style = window.getComputedStyle(element)
        const centerX = rect.x + rect.width / 2
        const centerY = rect.y + rect.height / 2
        const topElement = document.elementFromPoint(centerX, centerY)
        const describe = (candidate) => {
          if (!candidate) return null
          return {
            tagName: candidate.tagName,
            id: candidate.id || "",
            className: String(candidate.className || ""),
            href: candidate.href || ""
          }
        }
        return {
          target: describe(element),
          connected: element.isConnected,
          disabled: element.disabled || false,
          rect: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height
          },
          style: {
            display: style.display,
            visibility: style.visibility,
            opacity: style.opacity,
            pointerEvents: style.pointerEvents,
            position: style.position,
            zIndex: style.zIndex,
            transform: style.transform
          },
          elementAtCenter: describe(topElement),
          documentHasFocus: document.hasFocus(),
          activeElement: describe(document.activeElement)
        }
      })
    )
    write("target", { label, details })
    await captureCheckpoint(`before-${label}`)
  }

  return { captureCheckpoint, captureTarget, runStep }
}

test("diagnoses Electron story loading and interactions", async ({
  browserName: _browserName
}, testInfo) => {
  const diagnostic = createDiagnosticLog(testInfo)
  const write = diagnostic.write
  let pageServer
  let electronApp
  let userData
  let window
  let captureCheckpoint

  try {
    write("runner", {
      node: process.version,
      playwright: require("@playwright/test/package.json").version,
      electron: require("electron/package.json").version,
      platform: process.platform,
      arch: process.arch,
      osType: os.type(),
      osRelease: os.release(),
      osVersion: os.version(),
      hostname: os.hostname(),
      cpuCount: os.cpus().length,
      totalMemory: os.totalmem(),
      freeMemory: os.freemem(),
      cwd: process.cwd(),
      tempDirectory: os.tmpdir(),
      electronLaunchEnv: STORY_ENV.env,
      env: {
        CI: process.env.CI || "",
        GITHUB_ACTIONS: process.env.GITHUB_ACTIONS || "",
        RUNNER_OS: process.env.RUNNER_OS || "",
        RUNNER_ARCH: process.env.RUNNER_ARCH || "",
        DEBUG: process.env.DEBUG || "",
        ELECTRON_ENABLE_LOGGING: process.env.ELECTRON_ENABLE_LOGGING || "",
        ELECTRON_ENABLE_STACK_DUMPING:
          process.env.ELECTRON_ENABLE_STACK_DUMPING || ""
      }
    })

    pageServer = await startPageServer({
      onRequest: (details) => write("fixture-server", details)
    })
    const origin = pageServer.origin
    const urls = storyFixture.storyUrls(origin)
    const sourceLine = storyFixture.sourceLine(origin)
    write("fixture-started", { origin, urls, sourceLine })

    ;({ electronApp, userData, window } = await launchApp(STORY_ENV))
    attachRuntimeListeners(electronApp, window, write)
    write("app-launched", { userData })

    const helpers = diagnosticHelpers(
      testInfo,
      electronApp,
      window,
      write
    )
    captureCheckpoint = helpers.captureCheckpoint
    const { captureTarget, runStep } = helpers
    await captureCheckpoint("01-after-launch")

    const animation = await runStep("02-open-theme-settings", () =>
      openSettingsSection(window, "theme", "#anim_checkbox")
    )
    await runStep("03-disable-animations", () =>
      animation.uncheck({ timeout: OPERATION_TIMEOUT })
    )

    const sources = await runStep("04-open-source-settings", () =>
      openSettingsSection(window, "sources", '[data-testid="sources"]')
    )
    await runStep("05-inject-source", () =>
      sources.evaluate((textarea, value) => {
        textarea.value = value
      }, sourceLine)
    )
    await runStep("06-verify-source", () =>
      expect(sources).toHaveValue(sourceLine, { timeout: OPERATION_TIMEOUT })
    )
    await runStep("07-save-source", () =>
      window
        .getByTestId("save-sources")
        .evaluate((button) => button.click())
    )

    const sampleStartedAt = Date.now()
    for (const targetMs of [0, 250, 1_000, 5_000, 10_000]) {
      const remaining = targetMs - (Date.now() - sampleStartedAt)
      if (remaining > 0) await delay(remaining)
      await captureCheckpoint(`08-story-sample-${targetMs}ms`)
    }

    await runStep("09-open-stories", () =>
      window
        .getByTestId("stories-menu")
        .locator(":scope > .heading")
        .click({ timeout: OPERATION_TIMEOUT })
    )
    await runStep("10-clear-search", () =>
      window.locator("#searchfield").fill("", {
        timeout: OPERATION_TIMEOUT
      })
    )

    const renderedHrefs = await bounded("read rendered story hrefs", () =>
      window
        .locator("#stories story-item")
        .evaluateAll((elements) => elements.map((element) => element.dataset.href))
    )
    write("rendered-story-hrefs", { renderedHrefs, expected: urls.alpha })
    if (!renderedHrefs.includes(urls.alpha)) {
      throw new Error(
        `Fixture alpha story was not rendered. Expected ${urls.alpha}; rendered ${JSON.stringify(renderedHrefs)}`
      )
    }

    const alpha = window.locator(
      `#stories story-item[data-href="${urls.alpha}"]`
    )
    const alphaTitle = alpha.locator("a.title")
    await captureTarget("10-alpha-title", alphaTitle)
    await runStep(
      "11-alpha-title-trial-click",
      () => alphaTitle.click({ trial: true, timeout: OPERATION_TIMEOUT })
    )
    await runStep("12-alpha-title-click", () =>
      alphaTitle.click({ timeout: OPERATION_TIMEOUT })
    )
    await runStep("13-verify-alpha-navigation", async () => {
      await expect(window.locator("#urlfield")).toHaveValue(urls.alpha, {
        timeout: OPERATION_TIMEOUT
      })
      await expect(alpha).toHaveClass(/\bread\b/, {
        timeout: OPERATION_TIMEOUT
      })
      await expect(alpha).not.toHaveClass(/skipped/, {
        timeout: OPERATION_TIMEOUT
      })
    })

    const beta = window.locator(
      `#stories story-item[data-href="${urls.beta}"]`
    )
    const betaTitle = beta.locator("a.title")
    await captureTarget("14-beta-title", betaTitle)
    await runStep(
      "15-beta-middle-trial-click",
      () =>
        betaTitle.click({
          button: "middle",
          trial: true,
          timeout: OPERATION_TIMEOUT
        })
    )
    await runStep("16-beta-middle-click", () =>
      betaTitle.click({ button: "middle", timeout: OPERATION_TIMEOUT })
    )
    await runStep("17-verify-beta-tab", async () => {
      await expect
        .poll(() => window.evaluate(() => window.onceElectron.tabs.getAll()), {
          timeout: OPERATION_TIMEOUT
        })
        .toMatchObject([
          { url: urls.alpha, active: true },
          { url: urls.beta, active: false }
        ])
      await expect(beta).toHaveClass(/\bread\b/, {
        timeout: OPERATION_TIMEOUT
      })
    })

    const commentLinks = beta.locator(".info a.comment_url")
    await runStep("18-verify-comment-link-count", () =>
      expect(commentLinks).toHaveCount(2, { timeout: OPERATION_TIMEOUT })
    )
    for (const [index, expectedUrl] of [
      [0, urls.betaComments],
      [1, urls.betaSubstoryComments]
    ]) {
      const link = commentLinks.nth(index)
      await captureTarget(`19-comment-${index + 1}`, link)
      await runStep(
        `20-comment-${index + 1}-trial-click`,
        () => link.click({ trial: true, timeout: OPERATION_TIMEOUT })
      )
      await runStep(`21-comment-${index + 1}-click`, () =>
        link.click({ timeout: OPERATION_TIMEOUT })
      )
      await runStep(`22-verify-comment-${index + 1}-navigation`, () =>
        expect(window.locator("#urlfield")).toHaveValue(expectedUrl, {
          timeout: OPERATION_TIMEOUT
        })
      )
    }

    await captureCheckpoint("23-complete")
  } catch (error) {
    write("diagnostic-failed", serializeError(error))
    if (captureCheckpoint) {
      await captureCheckpoint("99-final-failure")
    }
    throw new Error(
      `Electron story diagnostic failed: ${serializeError(error).message}`,
      { cause: error }
    )
  } finally {
    if (electronApp && userData) {
      try {
        await bounded(
          "close Electron application",
          () => closeApp(electronApp, userData),
          5_000
        )
        write("app-closed")
      } catch (error) {
        write("app-close-error", serializeError(error))
        electronApp.process().kill()
      }
    }
    if (pageServer) {
      try {
        await bounded("close fixture server", () => pageServer.close(), 5_000)
        write("fixture-closed")
      } catch (error) {
        write("fixture-close-error", serializeError(error))
      }
    }
    write("diagnostic-finished")
    if (fs.existsSync(diagnostic.logPath)) {
      await testInfo.attach("diagnostics", {
        path: diagnostic.logPath,
        contentType: "application/x-ndjson"
      })
    }
  }
})
