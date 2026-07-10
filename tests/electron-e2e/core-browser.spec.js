const { test, expect, _electron: electron } = require("@playwright/test")
const http = require("node:http")
const os = require("node:os")
const path = require("node:path")
const fs = require("node:fs/promises")

let server
let origin

test.beforeAll(async () => {
  server = http.createServer((request, response) => {
    const page = request.url === "/two" ? "Two" : "One"
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    response.end(`<!doctype html><title>${page}</title><h1>${page}</h1>`)
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  origin = `http://127.0.0.1:${server.address().port}`
})

test.afterAll(async () => {
  await new Promise((resolve) => server.close(resolve))
})

test("launches a secure, navigable multi-tab browser shell", async () => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), "once-electron-test-"))
  const executablePath = path.resolve(
    __dirname,
    "../../node_modules/electron/dist/electron.exe"
  )
  const appPath = path.resolve(
    __dirname,
    "../../apps/electron/.webpack/x64/main/index.js"
  )
  const electronApp = await electron.launch({
    executablePath,
    args: [appPath],
    env: {
      ...process.env,
      ONCE_ELECTRON_TEST_USER_DATA: userData,
    },
  })
  try {
    await expect
      .poll(
        () =>
          electronApp.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows().length
          ),
        { timeout: 10_000 }
      )
      .toBe(1)
    const window = await electronApp.firstWindow()
    await expect(window.locator("#right_panel")).toBeVisible()
    await expect(window.locator(".electron-tab")).toHaveCount(1)

    const address = window.locator("#urlfield")
    await address.fill(`${origin}/one`)
    await address.press("Enter")
    await expect(address).toHaveValue(`${origin}/one`)

    await window.evaluate((url) => window.onceElectron.tabs.openUrl(url, "middle"), `${origin}/two`)
    await expect(window.locator(".electron-tab")).toHaveCount(2)
    await expect(address).toHaveValue(`${origin}/one`)

    await window.locator(".electron-tab").nth(1).click()
    await expect(address).toHaveValue(`${origin}/two`)

    const remoteIsolation = await electronApp.evaluate(async ({ webContents }, expectedUrl) => {
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
    expect(remoteIsolation).toEqual({
      requireType: "undefined",
      processType: "undefined",
      bridgeType: "undefined",
    })

    await window.locator(".electron-tab").nth(1).locator(".electron-tab-close").click()
    await expect(window.locator(".electron-tab")).toHaveCount(1)
  } finally {
    await electronApp.close()
    await fs.rm(userData, { recursive: true, force: true })
  }
})
