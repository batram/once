const { expect, test: baseTest } = require("@playwright/test")
const fs = require("node:fs/promises")

// What a browser context says while a spec drives it: console output and
// uncaught errors from every page and from an extension's MV3 service worker,
// failed requests, and lifecycle. A failing test gets it attached and its
// tail printed into the runner log, so a worker that threw on startup is
// reported as that, not as whichever UI assertion timed out downstream.
//
// Import `test` from here instead of @playwright/test: the auto fixture is
// what attaches the evidence, since a hard expect failure is not recorded on
// the test until its function has returned and a finally block cannot see it.

const observed = []

function observeContext(context, label = "browser") {
  const startedAt = Date.now()
  const lines = []
  const pageErrors = []
  const record = (source, text) => {
    const elapsed = String(Date.now() - startedAt).padStart(6)
    for (const line of String(text).split(/\r?\n/)) {
      lines.push(`${elapsed}ms [${source}] ${line}`)
    }
  }
  const watchTarget = (target, kind) => {
    target.on("console", (message) => record(`${kind}.${message.type()}`, message.text()))
    target.on("pageerror", (error) => {
      pageErrors.push(error.message)
      record(`${kind}.pageerror`, error.stack || error.message)
    })
  }
  const watchPage = (page) => {
    watchTarget(page, "page")
    page.on("crash", () => record("page", `crashed: ${page.url()}`))
    page.on("requestfailed", (request) => {
      record("request", `failed ${request.url()}: ${request.failure()?.errorText}`)
    })
  }
  if (typeof context.serviceWorkers === "function") {
    for (const worker of context.serviceWorkers()) watchTarget(worker, "worker")
    context.on("serviceworker", (worker) => watchTarget(worker, "worker"))
  }
  for (const page of context.pages()) watchPage(page)
  context.on("page", watchPage)
  context.on("close", () => record("context", "closed"))
  const evidence = {
    label,
    pageErrors,
    record,
    text: () => lines.join("\n")
  }
  observed.push(evidence)
  return evidence
}

async function attachEvidence(info, evidence, reason) {
  const text = evidence.text() || `(the ${evidence.label} wrote nothing)`
  // A file in the test's output directory travels with the CI artifact and
  // can be read without the trace viewer.
  const logPath = info.outputPath(`${evidence.label}-log.txt`)
  await fs.writeFile(logPath, `${reason ? `${reason}\n\n` : ""}${text}`)
  await info.attach(`${evidence.label}-log`, { path: logPath, contentType: "text/plain" })
  const tail = text.split("\n").slice(-40).join("\n")
  console.log(`\n--- ${evidence.label} log (${info.title}) ---\n${tail}\n--- end ${evidence.label} log ---`)
}

const test = baseTest.extend({
  // Playwright requires the destructuring form even when nothing is used.
  // eslint-disable-next-line no-empty-pattern
  browserEvidence: [async ({}, use, info) => {
    observed.length = 0
    await use()
    const failed = info.status !== info.expectedStatus || info.errors.length > 0
    const collected = observed.splice(0)
    if (!failed) return
    for (const evidence of collected) await attachEvidence(info, evidence)
  }, { auto: true }],
  // Playwright's own page fixture, observed the same way.
  page: async ({ page }, use) => {
    observeContext(page.context(), "page")
    await use(page)
  }
})

// Wait for the extension's MV3 service worker with a bounded budget. The bare
// context.waitForEvent has none, so a manifest or background-script error
// used to hang until the test timeout and report the wrong line.
async function waitForExtensionWorker(context, timeout = 20_000) {
  const [worker] = context.serviceWorkers()
  if (worker) return worker
  try {
    return await context.waitForEvent("serviceworker", { timeout })
  } catch (error) {
    throw new Error(
      `The extension service worker did not start within ${timeout}ms ` +
      "(a manifest or background script error keeps it from registering)",
      { cause: error }
    )
  }
}

// The extension page's own readiness flag. A page error during boot is a
// definite failure and is reported straight away instead of after the budget.
async function expectExtensionReady(page, evidence) {
  await expect.poll(() => {
    if (evidence.pageErrors.length) {
      throw new Error(`The extension page threw during startup:\n${evidence.pageErrors.join("\n")}`)
    }
    return page.locator("body").getAttribute("data-once-ready")
  }, { message: "the extension page did not become ready" }).toBe("true")
}

module.exports = { expect, expectExtensionReady, observeContext, test, waitForExtensionWorker }
