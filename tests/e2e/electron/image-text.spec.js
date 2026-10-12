const fs = require("node:fs/promises")
const { test, expect, launchApp, closeApp } = require("./electron-harness")
const { startImageTextServer } = require("../shared/image-text-fixture")

test.skip(!["darwin", "win32"].includes(process.platform), "Native OCR uses Apple Vision (macOS) or Windows.Media.Ocr (Windows)")
let server
test.beforeAll(async () => { server = await startImageTextServer() })
test.afterAll(async () => { await server?.close() })

async function inPage(app, script) {
  return app.evaluate(({ webContents }, { url, script }) => {
    const page = webContents.getAllWebContents().find(c => c.getURL() === url)
    if (!page) throw new Error("Missing image fixture")
    return page.executeJavaScript(script)
  }, { url: `${server.origin}/`, script })
}

/**
 * Runs a script in the selection's words frame: the app's cross-origin frame
 * anchored to the image (see browser/ImageTextOverlay.ts); null while none is open.
 */
async function inOverlay(app, script) {
  return app.evaluate(({ webContents }, script) => {
    for (const contents of webContents.getAllWebContents()) {
      const frame = contents.mainFrame?.framesInSubtree.find(f => f.url.startsWith("once-image-text:"))
      if (frame) return frame.executeJavaScript(script)
    }
    return null
  }, script)
}

/**
 * Where the selection's parts are, from its host in the image's frame, in
 * that frame's viewport: the words frame, its clip, and the bar; null while
 * none is open.
 */
async function overlayState(app, url = `${server.origin}/`) {
  return app.evaluate(({ webContents }, url) => {
    const tab = webContents.getAllWebContents().find(c => c.getURL() === url)
    return tab ? globalThis.__onceImageTextState(tab) : null
  }, url)
}

/** The part of the words frame its clip leaves, in the image frame's viewport. */
function visibleOf(state) {
  const [top, right, bottom, left] = (state.clipPath.match(/[\d.]+px/g) ?? ["0", "0", "0", "0"]).map(parseFloat)
  return { left: state.frame.left + left, top: state.frame.top + top,
    right: state.frame.left + state.frame.width - right, bottom: state.frame.top + state.frame.height - bottom }
}

/**
 * Sends input to the tab, where the words frame takes it like any frame;
 * points are in the page's viewport. Through the DevTools protocol, which
 * routes input to the frame under the point as real input is:
 * sendInputEvent hands it to the main frame only, never to a frame in
 * another process, such as the words frame.
 */
async function overlayInput(app, events) {
  await app.evaluate(async ({ webContents }, { url, events }) => {
    const tab = webContents.getAllWebContents().find(c => c.getURL() === url)
    if (!tab.debugger.isAttached()) tab.debugger.attach("1.3")
    const virtualKeys = { A: 65, Escape: 27, PageDown: 34 }
    for (const event of events) {
      const modifiers = (event.modifiers ?? []).includes("control") ? 2 : 0
      if (event.type.startsWith("mouse")) {
        const pressed = event.type === "mouseDown" || (event.modifiers ?? []).includes("leftButtonDown")
        await tab.debugger.sendCommand("Input.dispatchMouseEvent", {
          type: { mouseDown: "mousePressed", mouseUp: "mouseReleased", mouseMove: "mouseMoved" }[event.type],
          x: Math.round(event.x), y: Math.round(event.y), button: event.button ?? "none", buttons: pressed ? 1 : 0,
          clickCount: event.clickCount ?? 0, modifiers
        })
        if (event.type === "mouseMove") await new Promise(resolve => setTimeout(resolve, 16))
      } else {
        const key = event.keyCode
        await tab.debugger.sendCommand("Input.dispatchKeyEvent", {
          type: event.type === "keyDown" ? "rawKeyDown" : "keyUp", key: key.length === 1 ? key.toLowerCase() : key,
          code: key.length === 1 ? `Key${key}` : key, windowsVirtualKeyCode: virtualKeys[key], modifiers
        })
      }
    }
  }, { url: `${server.origin}/`, events })
}

async function overlayOpen(app) {
  return Boolean(await app.evaluate(({ webContents }) => webContents.getAllWebContents()
    .some(c => c.mainFrame?.framesInSubtree.some(f => f.url.startsWith("once-image-text:")))))
}

const READY = `Drag to select text · ${process.platform === "darwin" ? "⌘C" : "Ctrl+C"} to copy`

async function startRecognition(app) {
  await app.evaluate(async ({ webContents, Menu }, url) => {
    const page = webContents.getAllWebContents().find(c => c.getURL() === url)
    const params = await page.executeJavaScript(`(() => {
      const image = document.querySelector('img'), r = image.getBoundingClientRect();
      return {srcURL:image.currentSrc, x:r.left+r.width/2, y:r.top+r.height/2};
    })()`)
    const original = Menu.buildFromTemplate
    let action
    Menu.buildFromTemplate = template => {
      action = template.find(item => item.label === "Select Text in Image")
      return { popup() {} }
    }
    try {
      page.emit("context-menu", {}, { ...params, frame: page.mainFrame,
        hasImageContents: true, isEditable: false, selectionText: "", linkURL: "", editFlags: {}, pageURL: url })
    } finally { Menu.buildFromTemplate = original }
    if (!action) throw new Error("Missing native image text action")
    action.click()
  }, `${server.origin}/`)
  await expect.poll(async () => (await overlayState(app))?.bar?.text).toContain(READY)
}

/** The page's image, and the overlay's words, highlight and bar, all in the page's viewport. */
async function geometry(app) {
  const state = await overlayState(app)
  const page = await inPage(app, `(() => ({image:document.querySelector('img').getBoundingClientRect().toJSON(),
    viewport:{width:innerWidth,height:innerHeight,clientWidth:document.scrollingElement.clientWidth}}))()`)
  // The words frame's own coordinates, moved to where the frame is in the page.
  const shift = (rect) => rect && state && { ...rect, left: rect.left + state.frame.left, right: rect.right + state.frame.left,
    top: rect.top + state.frame.top, bottom: rect.bottom + state.frame.top, x: rect.x + state.frame.left, y: rect.y + state.frame.top }
  const words = state ? await inOverlay(app, `(() => {
    const shadow=document.querySelector('[data-once-image-text]').shadowRoot;
    const highlight=shadow.querySelector('.highlights path');
    return {words:[...shadow.querySelectorAll('.word')].map(e=>({text:e.textContent, ...e.getBoundingClientRect().toJSON()})),
      highlight:highlight?.getAttribute('d'), highlightBox:highlight?.getBoundingClientRect().toJSON()};
  })()`) ?? { words: [] } : { words: [] }
  const bar = state?.bar && { ...state.bar, width: state.bar.right - state.bar.left, height: state.bar.bottom - state.bar.top }
  return { ...page, hidden: !state || state.hidden || !bar, highlight: words.highlight,
    words: words.words.map(word => shift(word)), highlightBox: shift(words.highlightBox),
    bar, background: bar?.background }
}

/** Copies through the tab, as the copy shortcut does: from the focused frame, the words frame. */
async function copied(app, url = `${server.origin}/`) {
  return app.evaluate(async ({ webContents, clipboard }, url) => {
    const tab = webContents.getAllWebContents().find(c => c.getURL() === url)
    const previous = await clipboard.readText()
    clipboard.writeText("")
    try {
      tab.copy()
      for (let attempt = 0; attempt < 40 && !(await clipboard.readText()); attempt++) await new Promise(resolve => setTimeout(resolve, 25))
      return await clipboard.readText()
    } finally { clipboard.writeText(previous) }
  }, url)
}

async function selectAndCopy(app, url = `${server.origin}/`) {
  const selected = await inOverlay(app, `(() => {
    const root=document.querySelector('[data-once-image-text]').shadowRoot;
    const words=root.querySelectorAll('.word');
    const range=document.createRange(); range.setStart(words[0].firstChild,0);
    range.setEnd(words[2].firstChild,words[2].firstChild.length);
    const selection=window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    return selection.toString();
  })()`)
  const text = await copied(app, url)
  if (text !== selected) throw new Error(`Browser copy placed ${JSON.stringify(text)}, not the selected OCR text`)
  return text
}

/** How many matches the app's find in page reports for `text`; `keep` leaves the session open. */
async function findMatches(app, text, { keep = false } = {}) {
  return app.evaluate(({ webContents }, { url, text, keep }) => new Promise((resolve, reject) => {
    const tab = webContents.getAllWebContents().find(c => c.getURL() === url)
    const timer = setTimeout(() => reject(new Error(`No find result for ${text}`)), 5000)
    const found = (_event, result) => {
      if (!result.finalUpdate) return
      tab.removeListener("found-in-page", found)
      clearTimeout(timer)
      if (!keep) tab.stopFindInPage("clearSelection")
      resolve(result.matches)
    }
    tab.on("found-in-page", found)
    // findNext starts a session; a fresh query without it reports nothing.
    tab.findInPage(text, { findNext: true })
  }), { url: `${server.origin}/`, text, keep })
}

/** The tab as the window shows it: the selection is part of the page. */
async function capture(app, name) {
  const bytes = await app.evaluate(async ({ webContents }, url) => {
    const tab = webContents.getAllWebContents().find(c => c.getURL() === url)
    tab.invalidate()
    await tab.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
    return (await tab.capturePage()).toPNG().toString("base64")
  }, `${server.origin}/`)
  await fs.writeFile(test.info().outputPath(name), Buffer.from(bytes, "base64"))
}

test("native OCR selects and copies image words with stable geometry and cleanup", async () => {
  const { electronApp: app, userData, window } = await launchApp()
  try {
    await window.locator("#urlfield").fill(`${server.origin}/`)
    await window.locator("#urlfield").press("Enter")
    await expect(window.locator(".electron-tab-title")).toHaveText("Image text selection fixture")
    await startRecognition(app)
    // The reading flourish plays once over the found words, then removes itself.
    const scanning = "Boolean(document.querySelector('[data-once-image-text]').shadowRoot.querySelector('canvas.scan'))"
    await expect.poll(() => inOverlay(app, scanning)).toBe(true)
    await expect.poll(() => inOverlay(app, scanning), { timeout: 8_000 }).toBe(false)
    expect(await selectAndCopy(app)).toBe("Select these words")
    await expect.poll(async () => (await geometry(app)).highlight?.match(/M/g)?.length).toBe(1)
    const initial = await geometry(app)
    // A single uniform line band bridges spaces while ending at the text.
    expect(initial.highlightBox.left).toBeCloseTo(initial.words[0].left, 0)
    expect(initial.highlightBox.right).toBeCloseTo(initial.words[2].right, 0)
    expect(initial.words.map(w => w.text.trim()).join(" ")).toBe("Select these words Native Apple Vision Copy 12345 and punctuation.")
    // Glyph rectangles must not overlap the next word after spaces are added.
    for (const index of [0, 1, 3, 4, 6, 7, 8]) {
      expect(initial.words[index].right).toBeLessThanOrEqual(initial.words[index + 1].left + 1)
    }
    // The bar never covers recognized text: here it fits below the image.
    for (const word of initial.words) {
      const overlaps = initial.bar.left < word.right && word.left < initial.bar.right &&
        initial.bar.top < word.bottom && word.top < initial.bar.bottom
      expect(overlaps, `bar covers "${word.text.trim()}"`).toBe(false)
    }
    expect(initial.bar.top).toBeGreaterThanOrEqual(initial.image.bottom)
    // Find in page matches across recognized words, as in page text, not just inside one.
    expect(await findMatches(app, "punctuation")).toBe(1)
    expect(await findMatches(app, "these words")).toBe(1)
    expect(await findMatches(app, "Native Apple Vision")).toBe(1)
    // With the image scrolled away, find still goes to its words: Chromium
    // runs no scroll for a match in an off-screen cross-origin frame, so the
    // app brings the image back for it.
    await inPage(app, "scrollTo(0, document.scrollingElement.scrollHeight)")
    await expect.poll(() => inPage(app, "document.querySelector('img').getBoundingClientRect().bottom < 0")).toBe(true)
    expect(await findMatches(app, "Native Apple", { keep: true })).toBe(1)
    await expect.poll(() => inPage(app, `(() => { const r=document.querySelector('img').getBoundingClientRect();
      return r.bottom > 0 && r.top < innerHeight })()`)).toBe(true)
    await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find(c => c.getURL() === url)
      .stopFindInPage("clearSelection"), `${server.origin}/`)
    await inPage(app, "scrollTo(0,0)")
    await inPage(app, "scrollBy(0,80)")
    await expect.poll(async () => (await geometry(app)).words[0].top).toBeCloseTo(initial.words[0].top - 80, 0)
    await inPage(app, "scrollTo(0,document.body.scrollHeight)")
    await expect.poll(async () => (await geometry(app)).hidden).toBe(true)
    // A root with its own overflow (as some blogs set) scrolls the viewport, not a
    // clipping box: an image below the fold stays selectable.
    await inPage(app, `(() => {
      document.documentElement.style.overflowY='scroll';
      const spacer=document.createElement('div'); spacer.id='fold'; spacer.style.height='2000px'; document.body.prepend(spacer);
      document.querySelector('img').scrollIntoView({block:'center'});
    })()`)
    await expect.poll(async () => {
      const g = await geometry(app)
      return !g.hidden && g.words[0].top > g.image.top && g.words[0].bottom < g.image.bottom
    }).toBe(true)
    await inPage(app, "document.getElementById('fold').remove(); document.documentElement.style.overflowY=''")
    // An image wider than the viewport: the bar keeps its one-line width instead
    // of shrinking against the right edge, and stays clear of the scrollbar.
    await inPage(app, "scrollTo(0,0); document.querySelector('img').style.width='1600px'")
    await expect.poll(async () => {
      const g = await geometry(app)
      return g.bar.height < 60 && g.bar.right <= g.viewport.clientWidth - 8
    }).toBe(true)
    await inPage(app, "scrollTo(0,0); document.querySelector('img').style.width='350px'")
    await expect.poll(async () => (await geometry(app)).image.width).toBeCloseTo(354, 0)
    await expect.poll(async () => {
      const g = await geometry(app)
      return g.words[0].width > 0 && g.words[9].right < g.image.right
    }).toBe(true)
    const narrow = await geometry(app)
    expect(narrow.words[0].left).toBeGreaterThan(narrow.image.left)
    expect(narrow.words[9].right).toBeLessThan(narrow.image.right)
    // Raster text begins at x=65 on the 1000px canvas, even with letterboxing.
    expect(narrow.words[0].left - narrow.image.left).toBeGreaterThan(20)
    expect(narrow.words[0].left - narrow.image.left).toBeLessThan(29)
    for (const theme of ["light", "dark"]) {
      // The bar follows the system's theme, whatever the page styles itself.
      await app.evaluate(async ({ webContents }, { url, theme }) => {
        const tab = webContents.getAllWebContents().find(c => c.getURL() === url)
        if (!tab.debugger.isAttached()) tab.debugger.attach("1.3")
        await tab.debugger.sendCommand("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-color-scheme", value: theme }]
        })
      }, { url: `${server.origin}/`, theme })
      await expect.poll(async () => (await geometry(app)).background).toBe(theme === "light" ? "rgb(255, 255, 255)" : "rgb(37, 41, 48)")
      await capture(app, `image-selection-${theme}.png`)
    }
    // The page sees only the closed hosts: no words, no way into them, nothing in its own world.
    expect(await inPage(app, `(() => {
      const hosts=[...document.querySelectorAll('[data-once-image-text]')];
      return {hosts:hosts.length, open:hosts.some(host => host.shadowRoot), words:document.querySelectorAll('.word').length,
        globals:'__onceImageText' in window || '__onceImageTextAnchor' in window, frames:[...document.querySelectorAll('iframe')].length};
    })()`)).toEqual({ hosts: 2, open: false, words: 0, globals: false, frames: 0 })
    // Escape closes it from the page too.
    await app.evaluate(({ webContents }, url) => {
      webContents.getAllWebContents().find(c => c.getURL() === url).sendInputEvent({ type: "keyDown", keyCode: "Escape" })
    }, `${server.origin}/`)
    await expect.poll(() => overlayOpen(app)).toBe(false)
    // Exercise the authenticated-session fetch path separately from data URLs.
    const dataUrl = await inPage(app, "document.querySelector('img').src")
    server.setImage(Buffer.from(dataUrl.split(",")[1], "base64"))
    await inPage(app, `new Promise(resolve=>{const image=document.querySelector('img');image.onload=()=>resolve(true);image.src=${JSON.stringify(`${server.origin}/image.png`)};})`)
    await startRecognition(app)
    expect(await selectAndCopy(app)).toBe("Select these words")
    await inPage(app, `(() => {
      const image=document.querySelector('img'), scroller=document.createElement('div');
      scroller.id='image-scroll'; scroller.style.cssText='height:100px;overflow:auto';
      image.parentElement.before(scroller); scroller.append(image.parentElement);
      scroller.scrollTop=120;
    })()`)
    // The words frame is clipped to what the scroller leaves visible of the image.
    const scroller = await inPage(app, "document.getElementById('image-scroll').getBoundingClientRect().toJSON()")
    await expect.poll(async () => {
      const visible = visibleOf(await overlayState(app))
      return Math.abs(visible.top - scroller.top) <= 1 && visible.bottom - visible.top <= 101
    }).toBe(true)
    // It moves with the image as the scroller scrolls: anchored, it needs no word from the app.
    const before = (await overlayState(app)).frame.top
    await inPage(app, "document.getElementById('image-scroll').scrollTop=60")
    await expect.poll(async () => (await overlayState(app)).frame.top).toBeCloseTo(before + 60, 0)
    await inPage(app, "document.querySelector('img').remove()")
    await expect.poll(() => overlayOpen(app)).toBe(false)
  } finally { await closeApp(app, userData) }
})

test("triple-click selects a reflowed paragraph and copy joins its wrapped lines", async () => {
  const { electronApp: app, userData, window } = await launchApp()
  try {
    await window.locator("#urlfield").fill(`${server.origin}/`)
    await window.locator("#urlfield").press("Enter")
    await expect(window.locator(".electron-tab-title")).toHaveText("Image text selection fixture")
    // A paragraph wrapped over two lines, a gap, then a second paragraph.
    await inPage(app, `new Promise(resolve => {
      const canvas=document.createElement('canvas'); canvas.width=1000; canvas.height=360;
      const c=canvas.getContext('2d'); c.fillStyle='#fff'; c.fillRect(0,0,1000,360);
      c.fillStyle='#14253d'; c.font='40px Arial';
      c.fillText('The first paragraph wraps onto',40,70); c.fillText('a second line of text.',40,120);
      c.fillText('Another paragraph follows.',40,260);
      const image=document.querySelector('img'); image.onload=()=>resolve(true); image.src=canvas.toDataURL('image/png');
    })`)
    await startRecognition(app)
    const second = (await geometry(app)).words.find(w => w.text.trim() === "second")
    const point = { x: second.left + second.width / 2, y: second.top + second.height / 2 }
    await overlayInput(app, [{ type: "mouseDown", ...point, button: "left", clickCount: 3 },
      { type: "mouseUp", ...point, button: "left", clickCount: 3 }])
    const paragraph = "The first paragraph wraps onto a second line of text."
    await expect.poll(() => inOverlay(app, "getSelection().toString().replace(/\\s+/g,' ').trim()")).toBe(paragraph)
    expect(await copied(app)).toBe(paragraph)
    // The words frame's context menu Copy runs its copy command, so the reflow applies there too.
    const menuCopied = await app.evaluate(async ({ webContents, clipboard, Menu }, url) => {
      const tab = webContents.getAllWebContents().find(c => c.getURL() === url)
      const frame = tab.mainFrame.framesInSubtree.find(f => f.url.startsWith("once-image-text:"))
      const previous = await clipboard.readText()
      clipboard.writeText("")
      const original = Menu.buildFromTemplate
      let copyItem
      Menu.buildFromTemplate = template => {
        copyItem = template.find(item => item.label === "Copy")
        return { popup() {} }
      }
      try {
        tab.emit("context-menu", {}, { x: 10, y: 10, frame, pageURL: url, frameURL: frame.url, linkURL: "", editFlags: {},
          isEditable: false, hasImageContents: false, misspelledWord: "", dictionarySuggestions: [],
          selectionText: "The first paragraph wraps onto\na second line of text." })
      } finally { Menu.buildFromTemplate = original }
      if (!copyItem) throw new Error("Missing Copy item")
      try {
        copyItem.click()
        for (let attempt = 0; attempt < 40 && !(await clipboard.readText()); attempt++) await new Promise(resolve => setTimeout(resolve, 25))
        return await clipboard.readText()
      } finally { clipboard.writeText(previous) }
    }, `${server.origin}/`)
    expect(menuCopied).toBe(paragraph)
  } finally { await closeApp(app, userData) }
})

test("dragging across the image sweeps text instead of dragging, zooming or following its link", async () => {
  const { electronApp: app, userData, window } = await launchApp()
  try {
    await window.locator("#urlfield").fill(`${server.origin}/`)
    await window.locator("#urlfield").press("Enter")
    await expect(window.locator(".electron-tab-title")).toHaveText("Image text selection fixture")
    await startRecognition(app)
    const words = (await geometry(app)).words
    const first = words[0], last = words.find(word => word.text.trim() === "and")
    // From the image's empty margin left of the first line to the middle of the third.
    const from = { x: Math.round(first.left - 12), y: Math.round(first.top + first.height / 2) }
    const to = { x: Math.round(last.left + last.width / 2), y: Math.round(last.top + last.height / 2) }
    await overlayInput(app, [{ type: "mouseDown", ...from, button: "left", clickCount: 1 },
      ...Array.from({ length: 8 }, (_, index) => ({ type: "mouseMove", x: from.x + (to.x - from.x) * (index + 1) / 8,
        y: from.y + (to.y - from.y) * (index + 1) / 8, button: "left", modifiers: ["leftButtonDown"] })),
      { type: "mouseUp", ...to, button: "left", clickCount: 1 }])
    await expect.poll(() => inOverlay(app, "getSelection().toString().replace(/\\s+/g,' ').trim()"))
      .toMatch(/^Select these words Native Apple Vision Copy 12345 an?$/)
    // The press landed on the linked image's area: no navigation, the overlay stays.
    expect(await window.evaluate(async () => (await window.onceElectron.tabs.getAll()).find(t => t.active)?.url)).toBe(`${server.origin}/`)
    expect(await overlayOpen(app)).toBe(true)
    // Ctrl+A selects all recognized text while the overlay holds the selection.
    await overlayInput(app, [{ type: "keyDown", keyCode: "A", modifiers: ["control"] },
      { type: "keyUp", keyCode: "A", modifiers: ["control"] }])
    await expect.poll(() => inOverlay(app, "getSelection().toString().replace(/\\s+/g,' ').trim()"))
      .toBe("Select these words Native Apple Vision Copy 12345 and punctuation.")
  } finally { await closeApp(app, userData) }
})

test("smooth selection respects partial words, reverse dragging, and line breaks", async () => {
  const { electronApp: app, userData, window } = await launchApp()
  try {
    await window.locator("#urlfield").fill(`${server.origin}/`)
    await window.locator("#urlfield").press("Enter")
    await expect(window.locator(".electron-tab-title")).toHaveText("Image text selection fixture")
    await startRecognition(app)
    // Real pointer selection can expose different shadow-DOM ranges from
    // setBaseAndExtent, so exercise both before inspecting partial ranges.
    const word = (await geometry(app)).words[0]
    const point = { x: word.left + word.width / 2, y: word.top + word.height / 2 }
    // A whole double click, as a mouse makes one: over the word, a click, then the second.
    await overlayInput(app, [{ type: "mouseMove", ...point },
      { type: "mouseDown", ...point, button: "left", clickCount: 1 }, { type: "mouseUp", ...point, button: "left", clickCount: 1 },
      { type: "mouseDown", ...point, button: "left", clickCount: 2 }, { type: "mouseUp", ...point, button: "left", clickCount: 2 }])
    // Chromium on Windows extends a double-click word selection over the trailing space.
    await expect.poll(() => inOverlay(app, "getSelection().toString().trimEnd()")).toBe("Select")
    await expect.poll(async () => (await geometry(app)).highlight?.match(/M/g)?.length).toBe(1)
    const selected = await inOverlay(app, `(() => {
      const words=document.querySelector('[data-once-image-text]').shadowRoot.querySelectorAll('.word');
      getSelection().setBaseAndExtent(words[0].firstChild,3,words[2].firstChild,2);
      return getSelection().toString();
    })()`)
    expect(selected).toBe("ect these wo")
    await expect.poll(async () => {
      const current = await geometry(app)
      return current.highlightBox.left > current.words[0].left + 2 &&
        current.highlightBox.right < current.words[2].right - 2
    }).toBe(true)
    const forward = await geometry(app)
    expect(forward.highlightBox.left).toBeGreaterThan(forward.words[0].left + 2)
    expect(forward.highlightBox.right).toBeLessThan(forward.words[2].right - 2)
    await inOverlay(app, `(() => {
      const words=document.querySelector('[data-once-image-text]').shadowRoot.querySelectorAll('.word');
      getSelection().setBaseAndExtent(words[2].firstChild,2,words[0].firstChild,3);
    })()`)
    await expect.poll(async () => (await geometry(app)).highlight).toBe(forward.highlight)
    await inOverlay(app, `(() => {
      const words=document.querySelector('[data-once-image-text]').shadowRoot.querySelectorAll('.word');
      getSelection().setBaseAndExtent(words[0].firstChild,0,words[9].firstChild,4);
    })()`)
    await expect.poll(async () => (await geometry(app)).highlight?.match(/M/g)?.length).toBe(3)
    await capture(app, "smooth-multiline-selection.png")
    await inOverlay(app, "getSelection().removeAllRanges()")
    await expect.poll(async () => (await geometry(app)).highlight).toBe("")
  } finally { await closeApp(app, userData) }
})

test("the overlay stays out of the page's way: covered edges, keys and autoscroll reach the page", async () => {
  const { electronApp: app, userData, window } = await launchApp()
  try {
    await window.locator("#urlfield").fill(`${server.origin}/`)
    await window.locator("#urlfield").press("Enter")
    await expect(window.locator(".electron-tab-title")).toHaveText("Image text selection fixture")
    await startRecognition(app)
    expect((await geometry(app)).hidden).toBe(false)
    // A fixed header over the image's top: the words frame is clipped below it,
    // so the selection never shows through the page's own UI.
    await inPage(app, `(() => {
      const header=document.createElement('div'); header.id='header';
      header.style.cssText='position:fixed;top:0;left:0;right:0;height:90px;background:#334;z-index:5';
      document.body.append(header);
      scrollTo(0, document.querySelector('img').getBoundingClientRect().top + scrollY - 40);
    })()`)
    await expect.poll(async () => {
      const visible = visibleOf(await overlayState(app))
      const image = await inPage(app, "document.querySelector('img').getBoundingClientRect().toJSON()")
      return visible.top >= 89 && visible.top <= 92 && Math.abs(visible.bottom - (image.bottom - 2)) <= 2
    }).toBe(true)
    // The header paints over the selection itself, clip or no clip: the hosts
    // take the image's layer, under what the page stacks above the image.
    expect(await inPage(app, `(() => { const r=document.querySelector('img').getBoundingClientRect();
      return document.elementFromPoint(r.left + r.width / 2, 60)?.id })()`)).toBe("header")
    // Also a sticky header in one stacking context with the image, as GitHub's README box has.
    await inPage(app, `(() => {
      document.getElementById('header').remove();
      const main=document.querySelector('main'); main.style.isolation='isolate';
      const sticky=document.createElement('div'); sticky.id='sticky';
      sticky.style.cssText='position:sticky;top:0;height:60px;background:#334;z-index:1'; main.prepend(sticky);
      scrollTo(0, document.querySelector('img').getBoundingClientRect().top + scrollY - 30);
    })()`)
    await expect.poll(() => inPage(app, `(() => { const r=document.querySelector('img').getBoundingClientRect();
      return document.elementFromPoint(r.left + r.width / 2, 40)?.id })()`)).toBe("sticky")
    await inPage(app, "document.getElementById('sticky').remove(); document.querySelector('main').style.isolation=''; scrollTo(0,0)")
    // Page keys pressed in the words frame scroll the page, as from any frame.
    await overlayInput(app, [{ type: "keyDown", keyCode: "PageDown" }, { type: "keyUp", keyCode: "PageDown" }])
    // PageDown scrolls smoothly by most of a viewport: let it land before scrolling back.
    await expect.poll(() => inPage(app, `new Promise(resolve => { const y=scrollY;
      setTimeout(() => resolve(y > innerHeight / 2 && scrollY === y), 200) })`)).toBe(true)
    await inPage(app, "scrollTo(0,0)")
    await expect.poll(async () => visibleOf(await overlayState(app)).top).toBeGreaterThan(100)
    // A sweep held at the page's bottom edge scrolls the page. The image runs
    // past that edge here: protocol input is hit-tested event by event and so
    // never follows a sweep out of the words frame, as real input does once
    // the frame captures the mouse (see imageTextPointer.ts).
    await inPage(app, `(() => {
      for (const place of ['prepend','append']) {
        const room=document.createElement('div'); room.style.height='600px'; document.body[place](room);
      }
      scrollTo(0, document.querySelector('img').getBoundingClientRect().bottom + scrollY - innerHeight - 80);
    })()`)
    await expect.poll(async () => {
      const state = await overlayState(app)
      return state.frame.top + state.frame.height - (await inPage(app, "innerHeight"))
    }).toBeGreaterThan(20)
    const scrolledTo = await inPage(app, "scrollY")
    const { words: first, viewport } = await geometry(app)
    const start = { x: first[0].left + 2, y: first[0].top + first[0].height / 2 }
    await overlayInput(app, [{ type: "mouseMove", ...start }, { type: "mouseDown", ...start, button: "left", clickCount: 1 },
      { type: "mouseMove", x: start.x + 40, y: viewport.height - 4, button: "left", modifiers: ["leftButtonDown"] }])
    await expect.poll(() => inPage(app, "scrollY")).toBeGreaterThan(scrolledTo + 10)
    // It scrolls as far as the image's end, which comes to rest at the viewport's.
    await expect.poll(() => inPage(app, `new Promise(resolve => { const y=scrollY; setTimeout(() =>
      resolve(scrollY === y && Math.abs(document.querySelector('img').getBoundingClientRect().bottom - innerHeight) < 1), 200) })`))
      .toBe(true)
    await overlayInput(app, [{ type: "mouseUp", x: start.x + 40, y: viewport.height - 4, button: "left", clickCount: 1 }])
  } finally { await closeApp(app, userData) }
})

test("the selection stays with its tab when switching away and back", async () => {
  const { electronApp: app, userData, window } = await launchApp()
  try {
    await window.locator("#urlfield").fill(`${server.origin}/`)
    await window.locator("#urlfield").press("Enter")
    await expect(window.locator(".electron-tab-title")).toHaveText("Image text selection fixture")
    await startRecognition(app)
    await expect.poll(async () => (await geometry(app)).hidden).toBe(false)
    await window.evaluate((url) => window.onceElectron.tabs.openUrl(url, "middle"), `${server.origin}/framed`)
    await expect(window.locator(".electron-tab")).toHaveCount(2)
    // Part of the page, it hides and shows with the tab's own view.
    await window.locator(".electron-tab").last().click()
    await expect.poll(() => window.evaluate(async () => (await window.onceElectron.tabs.getAll()).find(t => t.active)?.url))
      .toBe(`${server.origin}/framed`)
    expect(await overlayOpen(app)).toBe(true)
    await window.locator(".electron-tab").first().click()
    await expect.poll(async () => (await geometry(app)).hidden).toBe(false)
    expect(await selectAndCopy(app)).toBe("Select these words")
  } finally { await closeApp(app, userData) }
})

test("an image in a cross-site iframe gets the selection, anchored in its own frame", async () => {
  const { electronApp: app, userData, window } = await launchApp()
  const url = `${server.origin}/framed`
  // The fixture's iframe, not the words frame the selection adds inside it.
  const child = () => app.evaluate(({ webContents }, url) => {
    const tab = webContents.getAllWebContents().find(c => c.getURL() === url)
    return tab.mainFrame.framesInSubtree.find(f => f !== tab.mainFrame && !f.url.startsWith("once-image-text:"))?.url ?? null
  }, url)
  try {
    await window.locator("#urlfield").fill(url)
    await window.locator("#urlfield").press("Enter")
    await expect(window.locator(".electron-tab-title")).toHaveText("Framed image text fixture")
    await expect.poll(child).toMatch(/^http:\/\/localhost:/)
    const inFrame = (script) => app.evaluate(({ webContents }, { url, script }) => {
      const tab = webContents.getAllWebContents().find(c => c.getURL() === url)
      return tab.mainFrame.framesInSubtree.find(f => f !== tab.mainFrame && !f.url.startsWith("once-image-text:")).executeJavaScript(script)
    }, { url, script })
    // The frame may still be loading (no image yet) when first asked.
    await expect.poll(() => inFrame("Boolean(document.querySelector('img')?.complete && document.querySelector('img').naturalWidth > 0)")).toBe(true)
    await app.evaluate(async ({ webContents, Menu }, url) => {
      const tab = webContents.getAllWebContents().find(c => c.getURL() === url)
      const frame = tab.mainFrame.framesInSubtree.find(f => f !== tab.mainFrame && !f.url.startsWith("once-image-text:"))
      const params = await frame.executeJavaScript(`(() => { const i=document.querySelector('img'), r=i.getBoundingClientRect();
        return {srcURL:i.currentSrc, x:r.left+r.width/2, y:r.top+r.height/2} })()`)
      const original = Menu.buildFromTemplate
      let action
      Menu.buildFromTemplate = template => { action = template.find(item => item.label === "Select Text in Image"); return { popup() {} } }
      try {
        tab.emit("context-menu", {}, { ...params, frame, hasImageContents: true, isEditable: false, selectionText: "",
          linkURL: "", editFlags: {}, pageURL: url })
      } finally { Menu.buildFromTemplate = original }
      action.click()
    }, url)
    await expect.poll(async () => (await overlayState(app, url))?.bar?.text).toContain("Drag to select text")
    // The words frame covers the image's content box (its border box less the 2px border), in the iframe's viewport.
    const placed = async () => {
      const state = await overlayState(app, url)
      const image = await inFrame("document.querySelector('img').getBoundingClientRect().toJSON()")
      return state && Math.abs(state.frame.left - (image.left + 2)) <= 1.5 && Math.abs(state.frame.top - (image.top + 2)) <= 1.5
    }
    await expect.poll(placed).toBe(true)
    expect(await selectAndCopy(app, url)).toBe("Select these words")
    // Scrolling the outer page moves the iframe and everything in it; scrolling inside it moves the image, and the words with it.
    await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find(c => c.getURL() === url).executeJavaScript("scrollTo(0, 100)"), url)
    await expect.poll(placed).toBe(true)
    await inFrame("scrollTo(0, 200)")
    await expect.poll(placed).toBe(true)
    // The outer page sees nothing of it; the iframe's page sees only the closed hosts.
    expect(await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find(c => c.getURL() === url)
      .executeJavaScript("Boolean(document.querySelector('[data-once-image-text]'))"), url)).toBe(false)
    expect(await inFrame("[...document.querySelectorAll('[data-once-image-text]')].some(host => host.shadowRoot) || '__onceImageTextAnchor' in window")).toBe(false)
    // Removing the iframe ends the selection.
    await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find(c => c.getURL() === url).executeJavaScript("document.getElementById('frame').remove()"), url)
    await expect.poll(() => overlayOpen(app)).toBe(false)
  } finally { await closeApp(app, userData) }
})

test("on an image filling the page the bar takes the corner covering the fewest words", async () => {
  const { electronApp: app, userData, window } = await launchApp()
  try {
    await window.locator("#urlfield").fill(`${server.origin}/`)
    await window.locator("#urlfield").press("Enter")
    await expect(window.locator(".electron-tab-title")).toHaveText("Image text selection fixture")
    // Text down the image's right side only; the image fills the viewport, so
    // the bar has no room above or below it.
    await inPage(app, `new Promise(resolve => {
      const canvas=document.createElement('canvas'); canvas.width=1000; canvas.height=1000;
      const c=canvas.getContext('2d'); c.fillStyle='#fff'; c.fillRect(0,0,1000,1000);
      c.fillStyle='#14253d'; c.font='44px Arial';
      c.fillText('Top right words',600,80); c.fillText('Bottom right words',560,950);
      const image=document.querySelector('img'); image.style.height='100vh'; image.style.objectFit='fill';
      image.onload=()=>{ image.scrollIntoView(); resolve(true) }; image.src=canvas.toDataURL('image/png');
    })`)
    await startRecognition(app)
    await expect.poll(async () => {
      const g = await geometry(app)
      if (!g.bar || g.words.length < 6) return "waiting"
      const overlaps = g.words.some(word => g.bar.left < word.right && word.left < g.bar.right && g.bar.top < word.bottom && word.top < g.bar.bottom)
      const inside = g.bar.top >= g.image.top && g.bar.bottom <= g.image.bottom
      // On a narrow image the bar can reach past the middle: compare its gaps to the image's sides.
      return overlaps ? "covers words" : inside && g.bar.left - g.image.left < g.image.right - g.bar.right ? "left corner" : "elsewhere"
    }).toBe("left corner")
  } finally { await closeApp(app, userData) }
})
