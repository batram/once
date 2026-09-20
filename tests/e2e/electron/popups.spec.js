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

for (const features of ["", "width=417,height=625"]) {
  test(`popup keeps its opener and does not trigger blocked fallback (${features || "tab"})`, async () => {
    const server = await startPageServer()
    const { electronApp, userData, window } = await launchApp()
    try {
      const source = `${server.origin}/one`
      const target = `${server.origin}/two`
      await window.evaluate(url => window.onceElectron.tabs.create(url, true), source)
      await expect.poll(() => electronApp.evaluate(({ webContents }, url) =>
        webContents.getAllWebContents().some(c => c.getURL() === url && !c.isLoading()), source)
      ).toBe(true)
      await electronApp.evaluate(async ({ webContents }, { source, target, features }) => {
        const opener = webContents.getAllWebContents().find(c => c.getURL() === source)
        await opener.executeJavaScript(`document.body.innerHTML = '<button style="position:fixed;left:0;top:0;width:200px;height:80px" id="sample">Sample</button>';
        document.querySelector('#sample').onclick = () => {
          window.sample = window.open(${JSON.stringify(target)}, 'SamplePlayer', ${JSON.stringify(features)});
          if (!window.sample) location.href = ${JSON.stringify(target)};
          window.sampleResult = { opened: !!window.sample, closed: window.sample?.closed };
        }; void 0`)
      }, { source, target, features })
      await focusPage(electronApp, source)
      await electronApp.evaluate(({ webContents }, source) => {
        const opener = webContents.getAllWebContents().find(c => c.getURL() === source)
        opener.sendInputEvent({ type: "mouseDown", x: 40, y: 30, button: "left", clickCount: 1 })
        opener.sendInputEvent({ type: "mouseUp", x: 40, y: 30, button: "left", clickCount: 1 })
      }, source)
      await expect.poll(() => electronApp.evaluate(async ({ webContents }, source) =>
        webContents.getAllWebContents().find(c => c.getURL() === source)
          ?.executeJavaScript("window.sampleResult"), source)
      ).toEqual({ opened: true, closed: false })
      await expect.poll(() => electronApp.evaluate(({ webContents }, target) =>
        webContents.getAllWebContents().filter(c => c.getURL() === target && !c.isLoading()).length,
      target)).toBe(1)
      expect(await electronApp.evaluate(({ webContents }, source) =>
        webContents.getAllWebContents().filter(c => c.getURL() === source).length, source)).toBe(1)
      expect(await electronApp.evaluate(async ({ webContents }, target) =>
        webContents.getAllWebContents().find(c => c.getURL() === target)
          .executeJavaScript("!!window.opener"), target)).toBe(true)
      expect(await electronApp.evaluate(async ({ webContents }, { source, target, features }) =>
        webContents.getAllWebContents().find(c => c.getURL() === source)
          .executeJavaScript(`window.open(${JSON.stringify(target)}, 'SamplePlayer',
            ${JSON.stringify(features)}) === window.sample`, true),
      { source, target, features })).toBe(true)
      await expect.poll(() => electronApp.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().length)).toBe(features ? 2 : 1)
      await electronApp.evaluate(async ({ webContents }, source) => {
        await webContents.getAllWebContents().find(c => c.getURL() === source)
          .executeJavaScript("window.sample.close()")
      }, source)
      await expect.poll(() => electronApp.evaluate(({ webContents }, target) =>
        webContents.getAllWebContents().filter(c => c.getURL() === target).length, target)).toBe(0)
    } finally {
      await closeApp(electronApp, userData)
      await server.close()
    }
  })
}

test("automatic and synthetic popups are blocked; the toolbar can open or dismiss them", async () => {
  const server = await startPageServer()
  const { electronApp, userData, window } = await launchApp()
  try {
    const source = `${server.origin}/one`
    const target = `${server.origin}/two`
    const id = await window.evaluate(url => window.onceElectron.tabs.create(url, true), source)
    await waitForPage(electronApp, source)
    const script = `window.open(${JSON.stringify(target)}, '_blank') === null`
    expect(await inPage(electronApp, source, script)).toBe(true)
    await expect(window.locator("#blocked_popups")).toHaveText("Popup blocked")
    expect(await inPage(electronApp, source, `(() => {
      const button = document.createElement('button');
      document.body.append(button);
      button.onclick = () => { window.syntheticBlocked = ${script}; };
      button.click();
      return window.syntheticBlocked;
    })()`)).toBe(true)
    await expect(window.locator("#blocked_popups")).toHaveText("2 popups blocked")
    await window.screenshot({ path: test.info().outputPath("blocked-popups.png") })
    expect(await window.evaluate(async () => (await window.onceElectron.tabs.getAll()).length)).toBe(2)

    await electronApp.evaluate(({ Menu }) => {
      Menu.buildFromTemplate = template => {
        globalThis.popupMenu = template
        return { popup() {} }
      }
    })
    await window.locator("#blocked_popups").click()
    await expect.poll(() => electronApp.evaluate(() => globalThis.popupMenu?.[0].label))
      .toBe(`Open ${target}`)
    await electronApp.evaluate(() => globalThis.popupMenu[0].click())
    await waitForPage(electronApp, target)
    await expect(window.locator("#blocked_popups")).toBeHidden()
    await window.evaluate(id => window.onceElectron.tabs.activate(id), id)
    await expect(window.locator("#blocked_popups")).toHaveText("Popup blocked")
    await window.locator("#blocked_popups").click()
    await electronApp.evaluate(() => globalThis.popupMenu.at(-1).click())
    await expect(window.locator("#blocked_popups")).toBeHidden()
    expect(await inPage(electronApp, source, script)).toBe(true)
    await expect(window.locator("#blocked_popups")).toBeVisible()
    await window.evaluate(({ id, source }) => window.onceElectron.tabs.navigate(id, source + "?next"), { id, source })
    await waitForPage(electronApp, source + "?next")
    await expect(window.locator("#blocked_popups")).toBeHidden()
  } finally {
    await closeApp(electronApp, userData)
    await server.close()
  }
})

test("a real keyboard event opens one popup and blocks a second from the same interaction", async () => {
  const server = await startPageServer()
  const { electronApp, userData, window } = await launchApp()
  try {
    const source = `${server.origin}/one`
    const target = `${server.origin}/two`
    const id = await window.evaluate(url => window.onceElectron.tabs.create(url, true), source)
    await waitForPage(electronApp, source)
    await inPage(electronApp, source, `document.onkeydown = event => {
      if (event.key !== 'Enter') return;
      window.keyboardResult = [!!window.open(${JSON.stringify(target)}, '_blank'),
        window.open(${JSON.stringify(target + "?second")}, '_blank') === null];
    }; void 0`)
    await focusPage(electronApp, source)
    await electronApp.evaluate(({ webContents }, source) => {
      const page = webContents.getAllWebContents().find(c => c.getURL() === source)
      page.sendInputEvent({ type: "keyDown", keyCode: "Return" })
      page.sendInputEvent({ type: "keyUp", keyCode: "Return" })
    }, source)
    await expect.poll(() => inPage(electronApp, source, "window.keyboardResult")).toEqual([true, true])
    await waitForPage(electronApp, target)
    await window.evaluate(id => window.onceElectron.tabs.activate(id), id)
    await expect(window.locator("#blocked_popups")).toHaveText("Popup blocked")
  } finally {
    await closeApp(electronApp, userData)
    await server.close()
  }
})
