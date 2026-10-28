// What a web page may not get from the browser around it: an extension's own
// pages with their API, the extension install prompt without having been
// acted on, and another document's reader copy.
const { test, expect, launchApp, closeApp, startPageServer } = require("./electron-harness")

async function inPage(electronApp, url, script) {
  return electronApp.evaluate(async ({ webContents }, { url, script }) =>
    webContents.getAllWebContents().find(c => c.getURL() === url).executeJavaScript(script),
  { url, script })
}

async function waitForPage(electronApp, url) {
  await expect.poll(() => electronApp.evaluate(({ webContents }, url) =>
    webContents.getAllWebContents().some(c => c.getURL() === url && !c.isLoading()), url)
  ).toBe(true)
}

async function focusPage(electronApp, url) {
  await electronApp.evaluate(({ webContents }, url) =>
    webContents.getAllWebContents().find(c => c.getURL() === url).focus(), url)
  await expect.poll(() => inPage(electronApp, url, "document.hasFocus()")).toBe(true)
  await inPage(electronApp, url,
    "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))")
}

/** A native click on the page, which is what the popup blocker and the install prompt count. */
async function clickPage(electronApp, url, button = "left") {
  await electronApp.evaluate(({ webContents }, { url, button }) => {
    const page = webContents.getAllWebContents().find(c => c.getURL() === url)
    const click = { x: 40, y: 30, button, clickCount: 1, modifiers: [] }
    page.sendInputEvent({ type: "mouseDown", ...click })
    page.sendInputEvent({ type: "mouseUp", ...click })
  }, { url, button })
}

async function extensionHost(electronApp, window, name) {
  await expect.poll(() => window.evaluate(async () =>
    (await window.onceElectron.extensions.list()).map((entry) => entry.name)
  ), { timeout: 15_000 }).toContain(name)
  const list = await window.evaluate(() => window.onceElectron.extensions.list())
  const host = list.find((entry) => entry.name === name).host
  await expect.poll(() => electronApp.evaluate(({ webContents }, origin) =>
    webContents.getAllWebContents().some((contents) => contents.getURL().startsWith(origin) && !contents.isLoading())
  , `moz-extension://${host}/`), { timeout: 15_000 }).toBe(true)
  return host
}

// The runtime gives an extension's own pages their session and API when the
// shell opens them. A link a page wrote must not get the same: Firefox refuses
// such a navigation, and here the tab stays page content, which the browser
// session answers with the extension's web-accessible files only.
test("a middle-clicked link to an extension page opens it as page content, without the API", async () => {
  const server = await startPageServer()
  const { electronApp, userData, window } = await launchApp()
  try {
    const host = await extensionHost(electronApp, window, "uBlock Origin")
    const source = `${server.origin}/one`
    const target = `moz-extension://${host}/dashboard.html`
    await window.evaluate(url => window.onceElectron.tabs.create(url, true), source)
    await waitForPage(electronApp, source)
    await inPage(electronApp, source, `document.body.innerHTML =
      '<a id="sample" style="position:fixed;left:0;top:0;width:200px;height:80px" ' +
      'href=${JSON.stringify(target)}>Sample</a>'; void 0`)
    await focusPage(electronApp, source)
    await clickPage(electronApp, source, "middle")
    await expect.poll(() => window.evaluate(async () =>
      (await window.onceElectron.tabs.getAll()).map(tab => tab.url)
    )).toContain(target)
    await expect.poll(() => electronApp.evaluate(({ webContents }, target) =>
      webContents.getAllWebContents().some(c => c.getURL() === target && !c.isLoading()), target)).toBe(true)
    const opened = await electronApp.evaluate(async ({ webContents, session }, { target, host }) => {
      const contents = webContents.getAllWebContents().find(c => c.getURL() === target)
      return {
        inExtensionSession: contents.session === session.fromPartition(`persist:once-ext:${host}`),
        ...await contents.executeJavaScript("({ api: typeof browser, text: document.body.innerText })", true)
      }
    }, { target, host })
    expect(opened).toEqual({ inExtensionSession: false, api: "undefined", text: "Not a web accessible resource" })
  } finally {
    await closeApp(electronApp, userData)
    await server.close()
  }
})

// A download of a Mozilla Add-ons package prompts to install it. The prompt
// must follow the user's own input on the page: a download the page starts by
// itself gets nothing, and the one that follows a click keeps Cancel as the
// default button so a baited keypress cannot confirm it.
test("the extension install prompt needs the user's input and defaults to Cancel", async () => {
  test.setTimeout(120_000)
  let fileUrl = null
  try {
    const listing = await (await fetch("https://addons.mozilla.org/api/v5/addons/addon/privacy-badger17/",
      { signal: AbortSignal.timeout(10_000) })).json()
    fileUrl = listing.current_version?.file?.url ?? null
  } catch { /* offline: the download link is a fixed shape, the prompt itself goes unchecked */ }
  const server = await startPageServer()
  const { electronApp, userData, window } = await launchApp()
  try {
    await electronApp.evaluate(({ dialog }) => {
      globalThis.installPrompts = []
      dialog.showMessageBox = async (...args) => {
        const options = args.find(a => a && typeof a === "object" && "message" in a)
        globalThis.installPrompts.push({ message: options?.message, buttons: options?.buttons, defaultId: options?.defaultId })
        return { response: 1 }
      }
      dialog.showErrorBox = (title, content) => { globalThis.installPrompts.push({ error: `${title}: ${content}` }) }
    })
    const prompts = () => electronApp.evaluate(() => globalThis.installPrompts)
    const source = `${server.origin}/one`
    const download = fileUrl ?? "https://addons.mozilla.org/firefox/downloads/file/1/unreachable.xpi"
    await window.evaluate(url => window.onceElectron.tabs.create(url, true), source)
    await waitForPage(electronApp, source)
    // Started by the page itself, in a frame it added: no input, no prompt.
    await inPage(electronApp, source, `document.body.innerHTML = '<iframe src=${JSON.stringify(download)}></iframe>'; void 0`)
    await new Promise(resolve => setTimeout(resolve, 6_000))
    expect(await prompts()).toEqual([])
    test.skip(!fileUrl, "Mozilla Add-ons unreachable; the prompt after a click is not checked")

    await focusPage(electronApp, source)
    await clickPage(electronApp, source)
    await inPage(electronApp, source, `location.href = ${JSON.stringify(download)}; void 0`)
    await expect.poll(() => prompts(), { timeout: 90_000 }).toHaveLength(1)
    const [prompt] = await prompts()
    expect(prompt.error).toBeUndefined()
    expect(prompt.message).toMatch(/^Add Privacy Badger to Once\?$/)
    expect(prompt.buttons).toEqual(["Install", "Cancel"])
    expect(prompt.defaultId).toBe(1)
  } finally {
    await closeApp(electronApp, userData)
    await server.close()
  }
})

// A reader document lives at an origin of its own, behind a random token, and
// no page may frame it: the user's reader copy of a page is theirs alone.
test("a page cannot frame a reader document, and only the served URL answers", async () => {
  const server = await startPageServer()
  const { electronApp, userData, window } = await launchApp()
  try {
    const sourceUrl = `${server.origin}/secret-article`
    const html = "<!doctype html><html><body><article><p>READER-COPY-TEXT</p></article><script data-once-reader-runtime></script></body></html>"
    await window.evaluate(({ html, sourceUrl }) => window.onceElectron.tabs.openReader(html, sourceUrl, "blank"), { html, sourceUrl })
    await expect.poll(() => window.evaluate(async () =>
      (await window.onceElectron.tabs.getAll()).find(tab => tab.url.startsWith("once-reader://"))?.url ?? ""
    )).toMatch(/^once-reader:\/\/[a-f0-9]{32}\//)
    const served = (await window.evaluate(() => window.onceElectron.tabs.getAll())).find(tab => tab.url.startsWith("once-reader://")).url
    expect(served).toBe(`once-reader://${served.split("/")[2]}/${sourceUrl}`)
    await expect.poll(() => electronApp.evaluate(async ({ webContents }, served) => {
      const reader = webContents.getAllWebContents().find(c => c.getURL() === served)
      return reader && !reader.isLoading() ? reader.executeJavaScript("document.body.innerText") : ""
    }, served)).toContain("READER-COPY-TEXT")

    const page = `${server.origin}/one`
    await window.evaluate(url => window.onceElectron.tabs.create(url, true), page)
    await waitForPage(electronApp, page)
    const readable = `once-reader://${sourceUrl}`
    await inPage(electronApp, page, `document.body.innerHTML =
      '<iframe id="served" src=${JSON.stringify(served)}></iframe><iframe id="readable" src=${JSON.stringify(readable)}></iframe>'; void 0`)
    await new Promise(resolve => setTimeout(resolve, 3_000))
    const frames = await electronApp.evaluate(async ({ webContents }, page) => {
      const contents = webContents.getAllWebContents().find(c => c.getURL() === page)
      const texts = []
      for (const frame of contents.mainFrame.frames) {
        texts.push(await frame.executeJavaScript("document.body ? document.body.innerText : ''", true).catch(error => `blocked: ${error.message}`))
      }
      return texts
    }, page)
    expect(frames).toHaveLength(2)
    for (const text of frames) expect(text).not.toContain("READER-COPY-TEXT")
  } finally {
    await closeApp(electronApp, userData)
    await server.close()
  }
})
