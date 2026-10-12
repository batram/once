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

/** The overlay's views: words over the image, the bar beside it (see browser/ImageTextOverlay.ts). */
async function inOverlay(app, script, view = "words") {
  return app.evaluate(({ webContents }, { script, view }) => {
    const overlay = webContents.getAllWebContents()
      .find(c => c.getURL().includes("image_text_overlay") && c.getURL().endsWith("#bar") === (view === "bar"))
    return overlay ? overlay.executeJavaScript(script) : null
  }, { script, view })
}

/** The tab's and the overlay views' bounds in the window; an overlay view off screen is missing. */
async function viewBounds(app) {
  return app.evaluate(({ BrowserWindow, WebContentsView }, url) => {
    const win = BrowserWindow.getAllWindows().find(w => w.contentView.children.some(v => v.webContents?.getURL() === url))
    const views = win.contentView.children.filter(v => v instanceof WebContentsView)
    const find = test => views.find(v => test(v.webContents.getURL()))?.getBounds()
    return { tab: find(u => u === url), words: find(u => u.includes("image_text_overlay") && !u.endsWith("#bar")),
      bar: find(u => u.endsWith("#bar")) }
  }, `${server.origin}/`)
}

/** Sends input to the words view; points are in the page's viewport, as geometry() reports them. */
async function overlayInput(app, events) {
  const { tab, words } = await viewBounds(app)
  await app.evaluate(async ({ webContents }, { events, dx, dy }) => {
    const overlay = webContents.getAllWebContents().find(c => c.getURL().includes("image_text_overlay") && !c.getURL().endsWith("#bar"))
    for (const event of events) {
      overlay.sendInputEvent("x" in event ? { ...event, x: Math.round(event.x - dx), y: Math.round(event.y - dy) } : event)
      if (event.type === "mouseMove") await new Promise(resolve => setTimeout(resolve, 16))
    }
  }, { events, dx: words.x - tab.x, dy: words.y - tab.y })
}

async function overlayOpen(app) {
  return Boolean(await app.evaluate(({ webContents }) => webContents.getAllWebContents().some(c => c.getURL().includes("image_text_overlay"))))
}

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
  await expect.poll(() => inOverlay(app, "document.querySelector('[data-once-image-text]')?.shadowRoot.querySelector('[role=status]').textContent", "bar"))
    .toContain(`Drag to select text · ${process.platform === "darwin" ? "⌘C" : "Ctrl+C"} to copy`)
}

/** The page's image, and the overlay's words, highlight and bar, all in the page's viewport. */
async function geometry(app) {
  const bounds = await viewBounds(app)
  const page = await inPage(app, `(() => ({image:document.querySelector('img').getBoundingClientRect().toJSON(),
    viewport:{width:innerWidth,height:innerHeight,clientWidth:document.scrollingElement.clientWidth}}))()`)
  const shift = (rect, view) => rect && { ...rect, left: rect.left + view.x - bounds.tab.x, right: rect.right + view.x - bounds.tab.x,
    top: rect.top + view.y - bounds.tab.y, bottom: rect.bottom + view.y - bounds.tab.y, x: rect.x + view.x - bounds.tab.x, y: rect.y + view.y - bounds.tab.y }
  const words = bounds.words ? await inOverlay(app, `(() => {
    const shadow=document.querySelector('[data-once-image-text]').shadowRoot;
    const highlight=shadow.querySelector('.highlights path');
    return {words:[...shadow.querySelectorAll('.word')].map(e=>({text:e.textContent, ...e.getBoundingClientRect().toJSON()})),
      highlight:highlight?.getAttribute('d'), highlightBox:highlight?.getBoundingClientRect().toJSON()};
  })()`) : { words: [] }
  const bar = bounds.bar ? await inOverlay(app, `(() => {
    const bar=document.querySelector('[data-once-image-text]').shadowRoot.querySelector('.bar');
    return {rect:bar.getBoundingClientRect().toJSON(), background:getComputedStyle(bar).backgroundColor};
  })()`, "bar") : null
  return { ...page, hidden: !bounds.words || !bounds.bar, highlight: words.highlight,
    words: words.words.map(word => shift(word, bounds.words)), highlightBox: shift(words.highlightBox, bounds.words),
    bar: bar && shift(bar.rect, bounds.bar), background: bar?.background }
}

async function selectAndCopy(app) {
  return app.evaluate(async ({ webContents, clipboard }, url) => {
    const page = webContents.getAllWebContents().find(c => c.getURL().includes("image_text_overlay") && !c.getURL().endsWith("#bar"))
    const previous = await clipboard.readText()
    try {
      const selected = await page.executeJavaScript(`(() => {
        const root=document.querySelector('[data-once-image-text]').shadowRoot;
        const words=root.querySelectorAll('.word');
        const range=document.createRange(); range.setStart(words[0].firstChild,0);
        range.setEnd(words[2].firstChild,words[2].firstChild.length);
        const selection=window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
        return selection.toString();
      })()`)
      page.copy()
      for (let attempt = 0; attempt < 40; attempt++) {
        const copied = await clipboard.readText()
        if (copied === selected) return copied
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      throw new Error("Browser copy did not place the selected OCR text on the clipboard")
    } finally { clipboard.writeText(previous) }
  }, `${server.origin}/`)
}

/** The tab with the overlay's views over it, as the window shows them. */
async function capture(app, name) {
  const bytes = await app.evaluate(async ({ BrowserWindow, WebContentsView }, url) => {
    const win = BrowserWindow.getAllWindows().find(w => w.contentView.children.some(v => v.webContents?.getURL() === url))
    const views = win.contentView.children.filter(v => v instanceof WebContentsView &&
      (v.webContents.getURL() === url || v.webContents.getURL().includes("image_text_overlay")))
    const layers = []
    for (const view of views) {
      view.webContents.invalidate()
      await view.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
      layers.push({ bounds: view.getBounds(), src: (await view.webContents.capturePage()).toDataURL() })
    }
    return win.webContents.executeJavaScript(`(async () => {
      const layers=${JSON.stringify(layers)}, tab=layers[0].bounds, scale=devicePixelRatio, canvas=document.createElement('canvas');
      canvas.width=tab.width*scale; canvas.height=tab.height*scale;
      const context=canvas.getContext('2d'); context.scale(scale,scale);
      for (const layer of layers) {
        const image=new Image(); image.src=layer.src; await image.decode();
        context.drawImage(image, layer.bounds.x-tab.x, layer.bounds.y-tab.y, layer.bounds.width, layer.bounds.height);
      }
      return canvas.toDataURL('image/png').split(',')[1];
    })()`)
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
      // The bar is the app's, so it follows the app's theme, not the page's.
      await app.evaluate(async ({ webContents }, { theme }) => {
        const bar = webContents.getAllWebContents().find(c => c.getURL().includes("image_text_overlay") && c.getURL().endsWith("#bar"))
        if (!bar.debugger.isAttached()) bar.debugger.attach("1.3")
        await bar.debugger.sendCommand("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-color-scheme", value: theme }]
        })
      }, { theme })
      await expect.poll(async () => (await geometry(app)).background).toBe(theme === "light" ? "rgb(255, 255, 255)" : "rgb(37, 41, 48)")
      await capture(app, `image-selection-${theme}.png`)
    }
    // Escape closes it from the page too, and nothing of the overlay was ever in the page.
    expect(await inPage(app, "Boolean(document.querySelector('[data-once-image-text]')) || '__onceImageText' in window")).toBe(false)
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
    // The words view covers only what the scroller leaves visible of the image.
    const scroller = await inPage(app, "document.getElementById('image-scroll').getBoundingClientRect().toJSON()")
    await expect.poll(async () => {
      const { tab, words } = await viewBounds(app)
      return words && Math.abs(words.y - tab.y - scroller.top) <= 1 && words.height <= 101
    }).toBe(true)
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
    const copied = await app.evaluate(async ({ webContents, clipboard }) => {
      const page = webContents.getAllWebContents().find(c => c.getURL().includes("image_text_overlay") && !c.getURL().endsWith("#bar"))
      const previous = await clipboard.readText()
      clipboard.writeText("")
      try {
        page.copy()
        for (let attempt = 0; attempt < 40 && !(await clipboard.readText()); attempt++) await new Promise(resolve => setTimeout(resolve, 25))
        return await clipboard.readText()
      } finally { clipboard.writeText(previous) }
    })
    expect(copied).toBe(paragraph)
    // The overlay's context menu Copy runs its copy command, so the reflow applies there too.
    const menuCopied = await app.evaluate(async ({ webContents, clipboard, Menu }) => {
      const page = webContents.getAllWebContents().find(c => c.getURL().includes("image_text_overlay") && !c.getURL().endsWith("#bar"))
      const previous = await clipboard.readText()
      clipboard.writeText("")
      const original = Menu.buildFromTemplate
      let copyItem
      Menu.buildFromTemplate = template => {
        copyItem = template.find(item => item.label === "Copy")
        return { popup() {} }
      }
      try {
        page.emit("context-menu", {}, { x: 10, y: 10, frame: page.mainFrame, pageURL: page.getURL(), linkURL: "", editFlags: {},
          isEditable: false, hasImageContents: false, misspelledWord: "", dictionarySuggestions: [],
          selectionText: "The first paragraph wraps onto\na second line of text." })
      } finally { Menu.buildFromTemplate = original }
      if (!copyItem) throw new Error("Missing Copy item")
      try {
        copyItem.click()
        for (let attempt = 0; attempt < 40 && !(await clipboard.readText()); attempt++) await new Promise(resolve => setTimeout(resolve, 25))
        return await clipboard.readText()
      } finally { clipboard.writeText(previous) }
    })
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
    await overlayInput(app, [{ type: "mouseDown", ...point, button: "left", clickCount: 2 },
      { type: "mouseUp", ...point, button: "left", clickCount: 2 }])
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
    // A fixed header over the image's top: the words view starts below it, so
    // the selection never shows through the page's own UI.
    await inPage(app, `(() => {
      const header=document.createElement('div'); header.id='header';
      header.style.cssText='position:fixed;top:0;left:0;right:0;height:90px;background:#334;z-index:5';
      document.body.append(header);
      scrollTo(0, document.querySelector('img').getBoundingClientRect().top + scrollY - 40);
    })()`)
    await expect.poll(async () => {
      const { tab, words } = await viewBounds(app)
      const image = await inPage(app, "document.querySelector('img').getBoundingClientRect().toJSON()")
      return words && words.y - tab.y >= 89 && words.y - tab.y <= 92 && Math.abs(words.y + words.height - tab.y - (image.bottom - 2)) <= 2
    }).toBe(true)
    await inPage(app, "document.getElementById('header').remove(); scrollTo(0,0)")
    // Page keys pressed in the overlay scroll the page.
    await overlayInput(app, [{ type: "keyDown", keyCode: "PageDown" }, { type: "keyUp", keyCode: "PageDown" }])
    // PageDown scrolls smoothly: let it land (at the page's end) before scrolling back.
    await expect.poll(() => inPage(app, "Math.abs(scrollY - (document.scrollingElement.scrollHeight - document.scrollingElement.clientHeight)) <= 1")).toBe(true)
    await inPage(app, "scrollTo(0,0)")
    await expect.poll(async () => (await viewBounds(app)).words?.y - (await viewBounds(app)).tab.y).toBeGreaterThan(100)
    // A sweep held at the page's bottom edge scrolls the page.
    const { words: first } = await geometry(app)
    const { tab } = await viewBounds(app)
    const start = { x: first[0].left + 2, y: first[0].top + first[0].height / 2 }
    await overlayInput(app, [{ type: "mouseDown", ...start, button: "left", clickCount: 1 },
      { type: "mouseMove", x: start.x + 40, y: tab.height - 4, button: "left", modifiers: ["leftButtonDown"] }])
    await expect.poll(() => inPage(app, "scrollY")).toBeGreaterThan(40)
    await overlayInput(app, [{ type: "mouseUp", x: start.x + 40, y: tab.height - 4, button: "left", clickCount: 1 }])
  } finally { await closeApp(app, userData) }
})

test("an image in a cross-site iframe gets the overlay, placed through the frame and following it", async () => {
  const { electronApp: app, userData, window } = await launchApp()
  const url = `${server.origin}/framed`
  const child = () => app.evaluate(({ webContents }, url) => {
    const tab = webContents.getAllWebContents().find(c => c.getURL() === url)
    return tab.mainFrame.framesInSubtree.find(f => f !== tab.mainFrame)?.url ?? null
  }, url)
  try {
    await window.locator("#urlfield").fill(url)
    await window.locator("#urlfield").press("Enter")
    await expect(window.locator(".electron-tab-title")).toHaveText("Framed image text fixture")
    await expect.poll(child).toMatch(/^http:\/\/localhost:/)
    const inFrame = (script) => app.evaluate(({ webContents }, { url, script }) => {
      const tab = webContents.getAllWebContents().find(c => c.getURL() === url)
      return tab.mainFrame.framesInSubtree.find(f => f !== tab.mainFrame).executeJavaScript(script)
    }, { url, script })
    await expect.poll(() => inFrame("document.querySelector('img').complete && document.querySelector('img').naturalWidth > 0")).toBe(true)
    await app.evaluate(async ({ webContents, Menu }, url) => {
      const tab = webContents.getAllWebContents().find(c => c.getURL() === url)
      const frame = tab.mainFrame.framesInSubtree.find(f => f !== tab.mainFrame)
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
    await expect.poll(() => inOverlay(app, "document.querySelector('[data-once-image-text]')?.shadowRoot.querySelector('[role=status]').textContent", "bar"))
      .toContain("Drag to select text")
    // The words view sits on the image: the iframe's content box (left 69, top 149) plus the image's place in it.
    const placed = async () => {
      const bounds = await app.evaluate(({ BrowserWindow, WebContentsView }, url) => {
        const win = BrowserWindow.getAllWindows().find(w => w.contentView.children.some(v => v.webContents?.getURL() === url))
        const views = win.contentView.children.filter(v => v instanceof WebContentsView)
        return { tab: views.find(v => v.webContents.getURL() === url).getBounds(),
          words: views.find(v => v.webContents.getURL().includes("image_text_overlay") && !v.webContents.getURL().endsWith("#bar"))?.getBounds() }
      }, url)
      const image = await inFrame("document.querySelector('img').getBoundingClientRect().toJSON()")
      const frameBox = await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find(c => c.getURL() === url)
        .executeJavaScript("(() => { const r=document.getElementById('frame').getBoundingClientRect(); return {left:r.left+9, top:r.top+9, bottom:r.bottom-9} })()"), url)
      // The image's border box less its 2px border, as the words view covers its content box.
      const left = frameBox.left + image.left + 2, top = frameBox.top + image.top + 2
      return { bounds, left, top, frameBox }
    }
    await expect.poll(async () => {
      const { bounds, left, top } = await placed()
      return bounds.words && Math.abs(bounds.words.x - bounds.tab.x - left) <= 1.5 && Math.abs(bounds.words.y - bounds.tab.y - top) <= 1.5
    }).toBe(true)
    expect(await selectAndCopy(app)).toBe("Select these words")
    // Scrolling the outer page moves the iframe: the views follow.
    await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find(c => c.getURL() === url).executeJavaScript("scrollTo(0, 100)"), url)
    await expect.poll(async () => {
      const { bounds, top } = await placed()
      return bounds.words && Math.abs(bounds.words.y - bounds.tab.y - top) <= 1.5
    }).toBe(true)
    // Scrolling inside the iframe clips the words view to the iframe's content box.
    await inFrame("scrollTo(0, 200)")
    await expect.poll(async () => {
      const { bounds, frameBox } = await placed()
      return bounds.words && Math.abs(bounds.words.y - bounds.tab.y - frameBox.top) <= 1.5
    }).toBe(true)
    // Nothing of the overlay is in either page.
    expect(await inFrame("Boolean(document.querySelector('[data-once-image-text]')) || '__onceImageText' in window")).toBe(false)
    // Removing the iframe ends the selection.
    await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find(c => c.getURL() === url).executeJavaScript("document.getElementById('frame').remove()"), url)
    await expect.poll(() => overlayOpen(app)).toBe(false)
  } finally { await closeApp(app, userData) }
})
