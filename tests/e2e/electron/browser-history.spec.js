const { test, expect, launchApp, closeApp, startPageServer } = require("./electron-harness")
const fs = require("node:fs/promises")

async function historyPage(app, script) {
  return app.evaluate(async ({ webContents }, source) => {
    const contents = webContents.getAllWebContents().find(tab => tab.getURL() === "once-history://view/index.html")
    return contents ? contents.executeJavaScript(source) : null
  }, script)
}

async function openHistory(app, window) {
  await window.locator("#browser_menu").click()
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(window => window.webContents.getURL().includes("browser_menu")))).toBe(true)
  await app.evaluate(({ BrowserWindow }) => {
    const menu = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes("browser_menu"))
    return menu.webContents.executeJavaScript('document.querySelector(\'[data-action="history"]\').click()')
  })
  await expect.poll(() => historyPage(app, 'document.querySelector("h1")?.textContent')).toBe("History")
}

test("browser menu history records foreground and background visits, searches and deletes", async () => {
  const server = await startPageServer()
  const { electronApp, window, userData } = await launchApp()
  try {
    await window.evaluate(url => window.onceElectron.tabs.create(url, true), `${server.origin}/one`)
    await window.evaluate(url => window.onceElectron.tabs.create(url, false), `${server.origin}/two`)
    await expect.poll(() => electronApp.evaluate(({ webContents }) => webContents.getAllWebContents().filter(tab => /\/(one|two)$/.test(tab.getURL()) && !tab.isLoading()).length)).toBe(2)
    await openHistory(electronApp, window)
    await expect.poll(() => historyPage(electronApp, 'document.querySelectorAll(".history-entry").length')).toBe(2)
    expect(await historyPage(electronApp, 'Array.from(document.querySelectorAll(".history-entry-title"),el=>el.textContent).sort()')).toEqual(["One", "Two"])
    await historyPage(electronApp, 'document.querySelector("input").value="/one"; document.querySelector("input").dispatchEvent(new Event("input"))')
    await expect.poll(() => historyPage(electronApp, 'document.querySelectorAll(".history-entry").length')).toBe(1)
    await historyPage(electronApp, 'document.querySelector(".history-remove").click()')
    await expect.poll(() => historyPage(electronApp, 'document.querySelectorAll(".history-entry").length')).toBe(0)
    await historyPage(electronApp, 'document.querySelector("input").value=""; document.querySelector("input").dispatchEvent(new Event("input"))')
    await expect.poll(() => historyPage(electronApp, 'document.querySelectorAll(".history-entry").length')).toBe(1)
    // Theme follows the shell even when the system uses another theme.
    await window.evaluate(() => window.onceElectron.window.setBackgroundColor("#f6f6ef"))
    await expect.poll(() => historyPage(electronApp, "document.body.dataset.theme")).toBe("light")
    await window.evaluate(() => window.onceElectron.window.setBackgroundColor("#282a36"))
    await expect.poll(() => historyPage(electronApp, "document.body.dataset.theme")).toBe("dark")
    // Verify density and alignment in the full shell at narrow and wide browser panes.
    for (const width of [900, 1280]) {
      await electronApp.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 800), width)
      for (const theme of ["light", "dark"]) {
        await window.evaluate(theme => {
          document.body.dataset.theme = theme
          return window.onceElectron.window.setBackgroundColor(theme === "dark" ? "#282a36" : "#f6f6ef")
        }, theme)
        const geometry = await historyPage(electronApp, `(() => {
          const header = document.querySelector(".history-header").getBoundingClientRect()
          const button = document.querySelector(".history-clear").getBoundingClientRect()
          const row = document.querySelector(".history-entry").getBoundingClientRect()
          const time = document.querySelector("time")
          const timeBox = time.getBoundingClientRect()
          const title = document.querySelector(".history-entry-title").getBoundingClientRect()
          return { time: time.textContent, timeInset: timeBox.left - row.left, titleTop: title.top, timeTop: timeBox.top, font: parseFloat(getComputedStyle(document.querySelector("h1")).fontSize),
            headerHeight: header.height, buttonHeight: button.height, buttonTop: button.top - header.top,
            buttonBottom: header.bottom - button.bottom, rowHeight: row.height,
            overflow: document.querySelector(".history-content").scrollWidth > innerWidth }
        })()`)
        expect(geometry.time).toMatch(/^\d{2}:\d{2}$/)
        expect(geometry.timeInset).toBeGreaterThanOrEqual(8)
        expect(Math.abs(geometry.timeTop - geometry.titleTop)).toBeLessThan(5)
        expect(geometry.font).toBe(13)
        expect(geometry.headerHeight).toBe(39)
        expect(geometry.buttonHeight).toBe(26)
        expect(geometry.buttonTop).toBeGreaterThanOrEqual(0)
        expect(geometry.buttonBottom).toBeGreaterThanOrEqual(0)
        expect(geometry.rowHeight).toBeLessThan(60)
        expect(geometry.overflow).toBe(false)
        const screenshot = await electronApp.evaluate(async ({ webContents }) => {
          const page = webContents.getAllWebContents().find(tab => tab.getURL() === "once-history://view/index.html")
          return (await page.capturePage()).toPNG().toString("base64")
        })
        await fs.writeFile(`test-results/history-electron-${theme}-${width}.png`, Buffer.from(screenshot, "base64"))
      }
    }
    await historyPage(electronApp, 'document.querySelector(".history-clear").click()')
    await historyPage(electronApp, 'document.querySelector(".history-cancel").click()')
    expect(await historyPage(electronApp, 'document.querySelectorAll(".history-entry").length')).toBe(1)
    await historyPage(electronApp, 'document.querySelector(".history-entry a").click()')
    await expect.poll(() => window.evaluate(() => window.onceElectron.tabs.getAll().then(tabs => tabs.find(tab => tab.active)?.url))).toBe(`${server.origin}/two`)
    await openHistory(electronApp, window)
    await expect.poll(() => historyPage(electronApp, 'document.querySelectorAll(".history-entry").length')).toBe(2)
    expect(await window.evaluate(() => window.onceElectron.tabs.getAll().then(tabs => tabs.filter(tab => tab.url.startsWith("once-history://")).length))).toBe(1)
    await historyPage(electronApp, 'document.querySelector(".history-clear").click(); document.querySelector(".history-confirm-delete").click()')
    await expect.poll(() => historyPage(electronApp, 'document.querySelector(".history-status").textContent')).toBe("No browsing history yet.")
  } finally { await closeApp(electronApp, userData); await server.close() }
})
