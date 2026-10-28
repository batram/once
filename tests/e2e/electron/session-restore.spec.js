const { test, expect } = require("./electron-harness")
const {
  closeApp,
  getOnceWindows,
  getWindowTabs,
  launchApp,
  startPageServer,
  transferTab
} = require("./electron-harness")

let pageServer
let origin

test.beforeAll(async () => {
  pageServer = await startPageServer()
  origin = pageServer.origin
})

test.afterAll(async () => pageServer.close())

const urlsOf = (tabs) => tabs.map((tab) => tab.url)

test("a relaunch restores each window with its own tabs, then reopens tabs closed before", async () => {
  test.setTimeout(120_000)
  const launched = await launchApp()
  const { userData } = launched
  let { electronApp, window } = launched
  try {
    const firstWindowId = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].id)
    const open = (url) => window.evaluate((target) => window.onceElectron.tabs.create(target, true), url)
    // A tab closed before the quit belongs on the reopen stack, not in the session.
    const closedId = await open(`${origin}/closed-before`)
    await expect.poll(() => getWindowTabs(electronApp, firstWindowId)).toHaveLength(2)
    await window.evaluate((id) => window.onceElectron.tabs.close(id), closedId)
    await expect.poll(() => getWindowTabs(electronApp, firstWindowId)).toHaveLength(1)

    await open(`${origin}/first-a`)
    await open(`${origin}/first-b`)
    const detachedId = await open(`${origin}/second`)
    await expect.poll(async () => urlsOf(await getWindowTabs(electronApp, firstWindowId)))
      .toEqual(["about:blank", `${origin}/first-a`, `${origin}/first-b`, `${origin}/second`])
    await transferTab(electronApp, firstWindowId, "detach", detachedId)
    await expect.poll(() => getOnceWindows(electronApp)).toHaveLength(2)
    // The first window quits with first-a selected, not its last tab.
    const firstA = (await getWindowTabs(electronApp, firstWindowId)).find((tab) => tab.url === `${origin}/first-a`)
    await window.evaluate((id) => window.onceElectron.tabs.activate(id), firstA.id)
    await expect.poll(async () =>
      (await getWindowTabs(electronApp, firstWindowId)).find((tab) => tab.active)?.url
    ).toBe(`${origin}/first-a`)
    // Give the debounced session snapshot no chance to matter: the quit flushes it.
    await closeApp(electronApp, userData, { keepUserData: true })

    ;({ electronApp, window } = await launchApp({ userData, restored: true }))
    await expect.poll(() => getOnceWindows(electronApp), { timeout: 30_000 }).toHaveLength(2)
    const windows = await getOnceWindows(electronApp)
    const byTabs = windows.map((candidate) => urlsOf(candidate.tabs)).sort((a, b) => b.length - a.length)
    // Blank starting tabs are not part of a session; everything else is back where it was.
    expect(byTabs).toEqual([[`${origin}/first-a`, `${origin}/first-b`], [`${origin}/second`]])
    const restoredFirst = windows.find((candidate) => candidate.tabs.length === 2)
    expect(restoredFirst.tabs.find((tab) => tab.active)?.url).toBe(`${origin}/first-a`)
    await expect.poll(async () =>
      (await getWindowTabs(electronApp, restoredFirst.id)).map((tab) => tab.title)
    ).toEqual(["First-a", "First-b"])

    // With the session back, Reopen closed tab reaches what was closed before it ended.
    const reopened = await electronApp.evaluate(async ({ BrowserWindow }, id) =>
      BrowserWindow.fromId(id).webContents.executeJavaScript("window.onceElectron.tabs.restoreClosed()"), restoredFirst.id)
    expect(reopened).toBeTruthy()
    await expect.poll(async () => urlsOf(await getWindowTabs(electronApp, restoredFirst.id)))
      .toEqual([`${origin}/first-a`, `${origin}/closed-before`, `${origin}/first-b`])
    expect(await electronApp.evaluate(async ({ BrowserWindow }, id) =>
      BrowserWindow.fromId(id).webContents.executeJavaScript("window.onceElectron.tabs.restoreClosed()"), restoredFirst.id)
    ).toBeNull()
  } finally {
    await closeApp(electronApp, userData)
  }
})

// A reader document lives in main's memory, so the next start cannot serve it
// again: the restored tab must fetch and rebuild the article on its own.
test("a relaunch brings a reader tab back with its article regenerated", async () => {
  test.setTimeout(120_000)
  const launch = (options = {}) => launchApp({ ...options, env: { ONCE_ELECTRON_DISABLE_NETWORK_FETCH: "0" } })
  const launched = await launch()
  const { userData } = launched
  let { electronApp, window } = launched
  const tabsOf = () => window.evaluate(async () =>
    (await window.onceElectron.tabs.getAll()).map((tab) => ({
      url: tab.url, title: tab.title, active: tab.active, loadError: tab.loadError
    })))
  try {
    const address = window.locator("#urlfield")
    await address.fill(`once-reader://${origin}/article`)
    await address.press("Enter")
    await expect(window.locator(".electron-tab-title")).toHaveText("Regenerated Article")
    // A plain page beside it, so the reader tab is not the only one restored.
    await window.evaluate((url) => window.onceElectron.tabs.create(url, false), `${origin}/first-a`)
    await expect.poll(tabsOf).toEqual([
      { url: expect.stringMatching(/^once-reader:\/\/[a-f0-9]{32}\//), title: "Regenerated Article", active: true, loadError: null },
      { url: `${origin}/first-a`, title: "First-a", active: false, loadError: null }
    ])
    await closeApp(electronApp, userData, { keepUserData: true })

    ;({ electronApp, window } = await launch({ userData, restored: true }))
    await expect.poll(tabsOf, { timeout: 30_000 }).toEqual([
      { url: expect.stringMatching(/^once-reader:\/\/[a-f0-9]{32}\//), title: "Regenerated Article", active: true, loadError: null },
      { url: `${origin}/first-a`, title: "First-a", active: false, loadError: null }
    ])
    await expect(window.locator("#urlfield")).toHaveValue(`once-reader://${origin}/article`)
    await expect(window.locator("#url_error")).toBeHidden()
    // The served document is really there, not just a tab that names it.
    await expect.poll(() => electronApp.evaluate(async ({ webContents }) => {
      const contents = webContents.getAllWebContents()
        .find((candidate) => candidate.getURL().startsWith("once-reader://") && candidate.getURL().endsWith("/article"))
      return contents ? contents.executeJavaScript("document.querySelector('h1')?.textContent ?? null") : null
    })).toBe("Regenerated Article")
  } finally {
    await closeApp(electronApp, userData)
  }
})
