const fs = require("node:fs/promises")
const { test, expect, launchApp, closeApp } = require("./electron-harness")
const { startImageTextServer } = require("../shared/image-text-fixture")

test.skip(process.platform !== "darwin", "Apple Vision is a macOS platform capability")
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
  await expect.poll(() => inPage(app, "document.querySelector('[data-once-image-text]')?.shadowRoot.querySelector('[role=status]').textContent"))
    .toContain("Drag to select text")
}

async function geometry(app) {
  return inPage(app, `(() => {
    const shadow=document.querySelector('[data-once-image-text]').shadowRoot;
    const image=document.querySelector('img'), r=image.getBoundingClientRect();
    const words=[...shadow.querySelectorAll('.word')].map(e=>({text:e.textContent, ...e.getBoundingClientRect().toJSON()}));
    const bar=shadow.querySelector('.bar');
    const highlight=shadow.querySelector('.highlights path');
    return {image:r.toJSON(), words, bar:bar.getBoundingClientRect().toJSON(), hidden:getComputedStyle(bar).display==='none',
      highlight:highlight?.getAttribute('d'), highlightBox:highlight?.getBoundingClientRect().toJSON(),
      background:getComputedStyle(bar).backgroundColor, viewport:{width:innerWidth,height:innerHeight}};
  })()`)
}

async function selectAndCopy(app) {
  return app.evaluate(async ({ webContents, clipboard }, url) => {
    const page = webContents.getAllWebContents().find(c => c.getURL() === url)
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

async function capture(app, name) {
  const bytes = await app.evaluate(async ({ webContents }, url) => {
    const page = webContents.getAllWebContents().find(c => c.getURL() === url)
    page.invalidate()
    await page.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
    return (await page.capturePage()).toPNG().toString("base64")
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
    expect(initial.bar.bottom).toBeLessThanOrEqual(initial.image.bottom)
    await inPage(app, "scrollBy(0,80)")
    await expect.poll(async () => (await geometry(app)).words[0].top).toBeCloseTo(initial.words[0].top - 80, 0)
    await inPage(app, "scrollTo(0,document.body.scrollHeight)")
    await expect.poll(async () => (await geometry(app)).hidden).toBe(true)
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
      await app.evaluate(async ({ webContents }, { theme, url }) => {
        const page = webContents.getAllWebContents().find(c => c.getURL() === url)
        if (!page.debugger.isAttached()) page.debugger.attach("1.3")
        await page.debugger.sendCommand("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-color-scheme", value: theme }]
        })
      }, { theme, url: `${server.origin}/` })
      await expect.poll(async () => (await geometry(app)).background).toBe(theme === "light" ? "rgb(255, 255, 255)" : "rgb(37, 41, 48)")
      await capture(app, `image-selection-${theme}.png`)
    }
    await inPage(app, "document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))")
    expect(await inPage(app, "Boolean(document.querySelector('[data-once-image-text]'))")).toBe(false)
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
    await expect.poll(() => inPage(app, `(() => {
      const clip=document.querySelector('[data-once-image-text]').shadowRoot.querySelector('.clip');
      return parseFloat(getComputedStyle(clip).clipPath.slice(6));
    })()`)).toBeGreaterThan(100)
    await inPage(app, "document.querySelector('img').remove()")
    await expect.poll(() => inPage(app, "Boolean(document.querySelector('[data-once-image-text]'))")).toBe(false)
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
    await app.evaluate(async ({ webContents }, url) => {
      const page = webContents.getAllWebContents().find(c => c.getURL() === url)
      const point = await page.executeJavaScript(`(() => {
        const word=document.querySelector('[data-once-image-text]').shadowRoot.querySelector('.word');
        const r=word.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};
      })()`)
      page.focus()
      page.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount: 2 })
      page.sendInputEvent({ type: "mouseUp", ...point, button: "left", clickCount: 2 })
    }, `${server.origin}/`)
    await expect.poll(() => inPage(app, "getSelection().toString()")).toBe("Select")
    await expect.poll(async () => (await geometry(app)).highlight?.match(/M/g)?.length).toBe(1)
    const selected = await inPage(app, `(() => {
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
    await inPage(app, `(() => {
      const words=document.querySelector('[data-once-image-text]').shadowRoot.querySelectorAll('.word');
      getSelection().setBaseAndExtent(words[2].firstChild,2,words[0].firstChild,3);
    })()`)
    await expect.poll(async () => (await geometry(app)).highlight).toBe(forward.highlight)
    await inPage(app, `(() => {
      const words=document.querySelector('[data-once-image-text]').shadowRoot.querySelectorAll('.word');
      getSelection().setBaseAndExtent(words[0].firstChild,0,words[9].firstChild,4);
    })()`)
    await expect.poll(async () => (await geometry(app)).highlight?.match(/M/g)?.length).toBe(3)
    await capture(app, "smooth-multiline-selection.png")
    await inPage(app, "getSelection().removeAllRanges()")
    await expect.poll(async () => (await geometry(app)).highlight).toBe("")
  } finally { await closeApp(app, userData) }
})
