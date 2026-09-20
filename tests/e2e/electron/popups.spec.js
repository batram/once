const { test, expect, launchApp, closeApp, startPageServer } = require("./electron-harness")

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
      const result = await electronApp.evaluate(async ({ webContents }, { source, target, features }) => {
        const opener = webContents.getAllWebContents().find(c => c.getURL() === source)
        return opener.executeJavaScript(`(() => {
          window.sample = window.open(${JSON.stringify(target)}, 'SamplePlayer', ${JSON.stringify(features)});
          if (!window.sample) location.href = ${JSON.stringify(target)};
          return { opened: !!window.sample, closed: window.sample?.closed };
        })()`, true)
      }, { source, target, features })
      expect(result).toEqual({ opened: true, closed: false })
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
