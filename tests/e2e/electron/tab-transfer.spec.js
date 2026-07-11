const { test, expect } = require("@playwright/test")
const {
  closeApp,
  getLiveContentsState,
  getOnceWindows,
  getWindowTabs,
  launchApp,
  markLiveContents,
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

test("moves a live tab out to a new Once window and back", async () => {
  const { electronApp, userData, window } = await launchApp()
  try {
    const detachedUrl = `${origin}/detached`
    const sourceWindowId = await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].id
    )

    await window.evaluate((url) => window.onceElectron.tabs.openUrl(url, "blank"), detachedUrl)
    await expect.poll(async () =>
      (await getWindowTabs(electronApp, sourceWindowId)).find((tab) => tab.url === detachedUrl)?.title
    ).toBe("Detached")

    const liveContentsId = await markLiveContents(electronApp, detachedUrl)
    const sourceTabs = await getWindowTabs(electronApp, sourceWindowId)
    expect(sourceTabs).toHaveLength(2)
    const detachedTab = sourceTabs.find((tab) => tab.url === detachedUrl)
    expect(detachedTab).toMatchObject({ url: detachedUrl, active: true })
    if (!detachedTab) throw new Error("Detached tab was not created")
    const detachedId = detachedTab.id

    await transferTab(electronApp, sourceWindowId, "detach", detachedId)
    const detachedWindows = await getOnceWindows(electronApp)
    expect(detachedWindows).toHaveLength(2)
    expect(detachedWindows.find((candidate) => candidate.id === sourceWindowId)?.tabs).toHaveLength(1)
    expect(detachedWindows.find((candidate) => candidate.id !== sourceWindowId)?.tabs).toEqual([
      expect.objectContaining({ id: detachedId, url: detachedUrl, active: true })
    ])
    expect(await getLiveContentsState(electronApp, liveContentsId)).toEqual({
      url: detachedUrl,
      state: 42
    })

    await transferTab(electronApp, sourceWindowId, "moveHere", detachedId)
    await expect.poll(async () => (await getOnceWindows(electronApp)).map(({ id }) => id))
      .toEqual([sourceWindowId])

    const restoredTabs = await getWindowTabs(electronApp, sourceWindowId)
    expect(restoredTabs).toHaveLength(2)
    expect(restoredTabs.find((tab) => tab.id === detachedId)).toMatchObject({
      url: detachedUrl,
      active: true
    })
    expect(await getLiveContentsState(electronApp, liveContentsId)).toEqual({
      url: detachedUrl,
      state: 42
    })
  } finally {
    await closeApp(electronApp, userData)
  }
})
