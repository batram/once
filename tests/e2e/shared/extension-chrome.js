const { chromium } = require("@playwright/test")
const fs = require("node:fs/promises")
const os = require("node:os")
const path = require("node:path")
const { createEvidence, observeContext, test } = require("./browser-evidence")
const { followChromeProcess } = require("./chrome-process-log")

// Chrome with the unpacked extension in a profile of its own, for the
// extension specs, and its teardown.
//
// Teardown used to fail now and then with "browserContext.close: Target page,
// context or browser has been closed" after every assertion had passed. With
// a persistent context Playwright gives that message, without a reason, only
// when Chrome's connection was already gone before the close request reached
// it: Chrome left on its own. Nothing said why, and deleting the profile
// deleted Chrome's crash reports with it. So Chrome's process log (launch,
// stderr, exit) goes into the test's evidence, and a browser that exits
// without being asked fails the test as exactly that, its exit code and crash
// reports kept beside the test's other output.

const EXTENSION_PATH = path.resolve(__dirname, "../../../apps/chrome-extension/dist/release")

/** Launches it, with the release build of Once's Chrome extension unless told otherwise. */
async function launchExtensionChrome({ label = "extension", profilePrefix = "once-chrome-", extensionPath = EXTENSION_PATH } = {}) {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), profilePrefix))
  const evidence = createEvidence(label)
  const chromeLog = createEvidence(`${label}-chrome`)
  const chrome = followChromeProcess((line) => {
    // Its stderr is chatty (sign-in, GCM): the full log is attached on its own,
    // and only the lifecycle goes into the main log beside the pages' output.
    chromeLog.record("chrome", line)
    if (line.startsWith("<")) evidence.record("chrome", line)
  })
  const teardown = { started: false, closedBeforeTeardown: false }
  let context
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      channel: "chromium",
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
    })
  } catch (error) {
    chrome.stop()
    await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
  observeContext(context, label, evidence)
  if (!chrome.state.available) evidence.record("chrome", "(the browser's process log is unavailable)")
  context.on("close", () => { if (!teardown.started) teardown.closedBeforeTeardown = true })

  /**
   * Closes the browser, then runs `cleanup` (fixture servers and the like)
   * and deletes the profile. Every step runs even when one before it fails.
   */
  async function close(...cleanup) {
    teardown.started = true
    evidence.record("teardown", "closing the browser")
    const failures = []
    let closeError = null
    try {
      await context.close()
    } catch (error) {
      closeError = error
    }
    // The exit is logged a moment after the connection drops.
    await chrome.exited(2_000)
    chrome.stop()
    const unexpected = unexpectedExit(chrome.state, teardown)
    if (unexpected) failures.push(await reportUnexpectedExit(unexpected, userDataDir, closeError))
    else if (closeError) failures.push(closeError)
    for (const step of [...cleanup, () => fs.rm(userDataDir, { recursive: true, force: true })]) {
      try {
        await step()
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length) throw failures[0]
  }

  // `chromeProcess`: what the process log has said so far (pid, exit).
  return { chromeProcess: chrome.state, context, evidence, userDataDir, close }
}

/** How Chrome went away without Playwright asking it to, or null when it was asked. */
function unexpectedExit(state, teardown) {
  if (state.exit && !state.exit.requested) {
    return { ...state.exit, when: teardown.closedBeforeTeardown ? "before teardown" : "during teardown, before the close request reached it" }
  }
  // Without the process log, only the context's own close event can tell.
  if (!state.available && teardown.closedBeforeTeardown) return { code: "unknown", signal: "unknown", when: "before teardown" }
  return null
}

async function reportUnexpectedExit(exit, userDataDir, cause) {
  // Chromium keeps its crash reports in the profile, which is about to go.
  let kept = "it left no crash reports"
  const crashpad = path.join(userDataDir, "Crashpad")
  try {
    await fs.access(crashpad)
    const destination = test.info().outputPath("chrome-crashpad")
    await fs.cp(crashpad, destination, { recursive: true })
    kept = `its crash reports are in ${destination}`
  } catch {
    // No Crashpad directory: nothing was written.
  }
  return new Error(
    `Chrome exited on its own ${exit.when} (exit code ${exit.code}, signal ${exit.signal}); ${kept}. ` +
    "Its process log is attached as the test's -chrome log.",
    { cause }
  )
}

module.exports = { launchExtensionChrome }
