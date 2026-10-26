const { test, expect, launchApp, closeApp } = require("./electron-harness")
const fs = require("node:fs")
const http = require("node:http")
const path = require("node:path")

const video = fs.readFileSync(path.resolve(__dirname, "../mobile/fixtures/extension-video.mp4"))

function serve(request, response) {
  const { pathname } = new URL(request.url, "http://localhost")
  if (pathname === "/start") {
    response.writeHead(200, { "content-type": "text/html" })
    response.end('<!doctype html><title>Start page</title><a id="download" href="/file.zip">Download</a>')
  } else if (pathname === "/file.zip") {
    response.writeHead(200, { "content-type": "application/zip", "content-disposition": "attachment; filename=file.zip" })
    response.end("PK")
  } else if (pathname === "/empty") {
    response.writeHead(204)
    response.end()
  } else if (pathname === "/moved") {
    response.writeHead(302, { location: "/clip.mp4" })
    response.end()
  } else {
    const type = pathname.endsWith(".mp3") ? "audio/mpeg" : "video/mp4"
    response.writeHead(200, { "content-type": type, "content-length": video.length, "accept-ranges": "bytes" })
    response.end(video)
  }
}

async function withApp(run) {
  const { electronApp, userData, window } = await launchApp()
  const server = http.createServer(serve)
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  // Downloads are the browser's business; here they only need to start.
  await electronApp.evaluate(({ session }) => {
    session.fromPartition("persist:once-browser-v2").on("will-download", event => event.preventDefault())
  })
  try {
    await run({ electronApp, window, origin: `http://127.0.0.1:${server.address().port}` })
  } finally {
    server.close()
    await closeApp(electronApp, userData)
  }
}

const tabState = (window, id) => window.evaluate(async id =>
  (await window.onceElectron.tabs.getAll()).find(tab => tab.id === id), id)

const shows = (electronApp, url, script) => electronApp.evaluate(({ webContents }, { url, script }) => {
  const tab = webContents.getAllWebContents().find(contents => contents.getURL() === url)
  return tab?.executeJavaScript(script) ?? null
}, { url, script })

// Chromium's media document never finishes loading, so loadURL rejects with
// ERR_FAILED while the player is up; the tab must keep it, not an error page.
test("video and audio files opened on their own play in the tab", async () => {
  await withApp(async ({ electronApp, window, origin }) => {
    for (const [file, element] of [["/clip.mp4", "video"], ["/clip.mp3", "video, audio"]]) {
      const url = origin + file
      const id = await window.evaluate(target => window.onceElectron.tabs.create(target, true), url)
      await expect.poll(() => shows(electronApp, url, `Boolean(document.querySelector(${JSON.stringify(element)}))`)).toBe(true)
      await expect.poll(() => tabState(window, id)).toMatchObject({ url, loadError: null, loading: false })
      // Long enough for a rejected load to have turned into an error page.
      await window.waitForTimeout(500)
      expect(await tabState(window, id)).toMatchObject({ url, loadError: null })
    }
  })
})

test("a redirect to a video names the tab after where it ended up", async () => {
  await withApp(async ({ window, origin }) => {
    const id = await window.evaluate(target => window.onceElectron.tabs.create(target, true), `${origin}/moved`)
    await expect.poll(() => tabState(window, id)).toMatchObject({
      url: `${origin}/clip.mp4`,
      title: expect.stringContaining("clip.mp4"),
      loadError: null
    })
  })
})

test("a navigation that downloads or returns no content keeps the page", async () => {
  await withApp(async ({ electronApp, window, origin }) => {
    const start = `${origin}/start`
    const id = await window.evaluate(target => window.onceElectron.tabs.create(target, true), start)
    await expect.poll(() => tabState(window, id)).toMatchObject({ url: start, title: "Start page", loading: false })

    for (const target of [`${origin}/file.zip`, `${origin}/empty`]) {
      await window.evaluate(([id, url]) => window.onceElectron.tabs.navigate(id, url), [id, target])
      await expect.poll(() => tabState(window, id)).toMatchObject({ url: start, title: "Start page", loadError: null, loading: false })
    }

    await shows(electronApp, start, "document.getElementById('download').click()")
    await window.waitForTimeout(500)
    await expect.poll(() => tabState(window, id)).toMatchObject({ url: start, title: "Start page", loadError: null, loading: false })
    expect(await shows(electronApp, start, "document.title")).toBe("Start page")
  })
})

test("the error page says what went wrong and shows the address as typed", async () => {
  await withApp(async ({ electronApp, window }) => {
    // "$&" and "$`" are String.replace patterns; the page must not expand them.
    const failed = "http://127.0.0.1:65534/unreachable?a=$&b=$`"
    const id = await window.evaluate(target => window.onceElectron.tabs.create(target, true), failed)
    await expect.poll(() => tabState(window, id)).toMatchObject({ loadError: "ERR_CONNECTION_REFUSED (-102)" })
    const page = () => electronApp.evaluate(({ webContents }) => {
      const contents = webContents.getAllWebContents().find(item => item.getURL().startsWith("once-error://"))
      return contents?.executeJavaScript(`({
        description: document.querySelector(".error-description")?.textContent,
        address: document.querySelector(".url-box")?.textContent,
        retry: document.querySelector(".retry")?.getAttribute("href")
      })`) ?? null
    })
    await expect.poll(page).toEqual({
      description: "The site refused to connect.",
      address: new URL(failed).href,
      retry: new URL(failed).href
    })
  })
})
