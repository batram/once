const { test, expect } = require("./electron-harness")
const { closeApp, launchApp, startPageServer } = require("./electron-harness")
const { pickerDriver } = require("./picker-driver")

// The overlay is closed to the page's world (see picker-driver), so these
// tests type and click for real through the driver.
const FIELDS = ".row input[type=text]"
const SAVE = "#actions .save"
const CANCEL = "#actions button:not(.save)"
const SOURCE_LINE = "#source textarea"
const SUMMARY = "#preview .summary"

let pageServer
let origin

test.beforeAll(async () => {
  pageServer = await startPageServer()
  origin = pageServer.origin
})

test.afterAll(async () => {
  await pageServer.close()
})

async function evaluateInPage(electronApp, url, script) {
  return electronApp.evaluate(async ({ webContents }, request) => {
    const contents = webContents
      .getAllWebContents()
      .find((candidate) => candidate.getURL() === request.url)
    if (!contents) throw new Error(`Missing webContents for ${request.url}`)
    return contents.executeJavaScript(request.script)
  }, { url, script })
}

async function openStoriesTab(window) {
  const [tab] = await window.evaluate(() => window.onceElectron.tabs.getAll())
  await window.evaluate(
    ({ id, url }) => window.onceElectron.tabs.navigate(id, url),
    { id: tab.id, url: `${origin}/stories` }
  )
  await expect(window.locator(".electron-tab-title")).toHaveText("Stories")
  return tab
}

/** Starts a pick whose outcome the test reads from `window.__oncePickResult`. */
async function startPick(electronApp, window) {
  await window.evaluate(() => {
    window.__oncePickResult = window.onceElectron.tabs.startSourcePicker()
  })
  const picker = pickerDriver(electronApp, `${origin}/stories`)
  await expect.poll(() => picker.present()).toBe(true)
  return picker
}

/** "pending" while the pick started by startPick has not settled. */
function pickState(window) {
  return window.evaluate(() => Promise.race([
    window.__oncePickResult.then(() => "settled", () => "settled"),
    new Promise((resolve) => setTimeout(() => resolve("pending"), 400))
  ]))
}

test("builds a geny source from picked selectors and saves it", async () => {
  const { electronApp, userData, window } = await launchApp()
  try {
    await openStoriesTab(window)

    // Start the picker through the settings button (full UI flow).
    await window.evaluate(() => {
      document.querySelector("#pick_source_button").click()
    })

    // The overlay appears inside the remote page with pick mode armed.
    const picker = pickerDriver(electronApp, `${origin}/stories`)
    await expect.poll(() => picker.present()).toBe(true)
    // Leave pick mode: the click catcher covers the page while it is armed.
    await picker.click(".row button")

    // Type the selectors and save.
    const values = ["li.story", "a.title", "a.title", "", "span.tag"]
    for (const [index, value] of values.entries()) {
      if (value) await picker.type(FIELDS, value, index)
    }
    // The preview follows the fields after a debounce: wait for it, not for a guess at it.
    await expect.poll(async () => (await picker.read(SUMMARY, "textContent"))[0])
      .toContain("3 stories parsed")
    const [first] = await picker.read("#preview .story", "textContent")
    expect(first).toContain("Story One")
    expect(first).toContain("tag-one")
    expect(await picker.read(SAVE, "disabled")).toEqual([false])

    await picker.click(SAVE)

    // The sanitized source object lands in the story sources document.
    await expect.poll(() =>
      window.evaluate(() => document.querySelector("#sources_area").value)
    ).toContain('"collector":"geny"')
    const sources = await window.evaluate(
      () => document.querySelector("#sources_area").value
    )
    const source = JSON.parse(sources).sources.find((entry) =>
      entry.collector === "geny")
    expect(source.url).toBe(`${origin}/stories`)
    expect(source.select).toEqual({
      stories: { sel: "li.story", all: true },
      link: { sel: "a.title", component: "href" },
      title: { sel: "a.title", component: "innerText", processors: ["trim"] },
      tags: [{ elements: { text: { sel: "span.tag", component: "innerText" } } }]
    })

    // The overlay is gone after saving.
    await expect.poll(() => picker.present()).toBe(false)
  } finally {
    await closeApp(electronApp, userData)
  }
})

test("picks stories, link, and title by clicking page elements", async () => {
  const { electronApp, userData, window } = await launchApp()
  try {
    await openStoriesTab(window)
    const picker = await startPick(electronApp, window)

    // Pick mode starts on the stories field and advances to link and title
    // as elements are clicked; every click lands on the second title link.
    const point = await evaluateInPage(electronApp, `${origin}/stories`, `
      (() => {
        const rect = document.querySelectorAll("a.title")[1].getBoundingClientRect()
        return { x: rect.x + 4, y: rect.y + 4 }
      })()
    `)
    // Each click fills the field pick mode is on, then moves to the next.
    for (let index = 0; index < 3; index++) {
      await picker.clickAt(point.x, point.y)
      await expect.poll(async () => (await picker.read(FIELDS, "value"))[index])
        .not.toBe("")
    }
    expect(await picker.read(FIELDS, "value"))
      .toEqual(["li.story", "a.title", "a.title", "", ""])

    await picker.click(SAVE)
    const source = await window.evaluate(() => window.__oncePickResult)
    expect(source.collector).toBe("geny")
    expect(source.url).toBe(`${origin}/stories`)
    expect(source.select).toEqual({
      stories: { sel: "li.story", all: true },
      link: { sel: "a.title", component: "href" },
      title: { sel: "a.title", component: "innerText", processors: ["trim"] }
    })
  } finally {
    await closeApp(electronApp, userData)
  }
})

test("cross updates the selector fields and the editable source line", async () => {
  const { electronApp, userData, window } = await launchApp()
  try {
    await openStoriesTab(window)
    const picker = await startPick(electronApp, window)
    await picker.click(".row button")

    // Fields feed the source line.
    await picker.type(FIELDS, "li.story")
    await expect.poll(async () => (await picker.read(SOURCE_LINE, "value"))[0])
      .toContain('"stories":{"all":true,"sel":"li.story"}')

    // Pasted config feeds the fields, the preview, and keeps extras
    // (comment_href has no form field) through the save round trip.
    const pastedConf = {
      stories: { sel: "ul.stories > li", all: true },
      link: { sel: "a.title", component: "href" },
      title: { sel: "a.title", component: "innerText" },
      comment_href: { sel: "a.title", component: "href" },
      tags: [{ elements: { text: { sel: "span.tag", component: "innerText" } } }]
    }
    await picker.type(SOURCE_LINE, JSON.stringify(pastedConf))
    await expect.poll(async () => (await picker.read(SUMMARY, "textContent"))[0])
      .toContain("3 stories parsed")
    expect(await picker.read(FIELDS, "value")).toEqual([
      "ul.stories > li", "a.title", "a.title", "", "span.tag"
    ])
    expect(await picker.read(SAVE, "disabled")).toEqual([false])

    await picker.click(SAVE)
    const source = await window.evaluate(() => window.__oncePickResult)
    expect(source.select).toEqual(pastedConf)
    expect(source.url).toBe(`${origin}/stories`)
  } finally {
    await closeApp(electronApp, userData)
  }
})

test("the page cannot start, fill, or finish the picker itself", async () => {
  const { electronApp, userData, window } = await launchApp()
  try {
    await openStoriesTab(window)
    const forged = JSON.stringify({
      stories: { sel: "li.story", all: true },
      link: { sel: "a.title", component: "href" },
      title: { sel: "a.title", component: "innerText" }
    })
    // A hostile page gets ready before the pick: a starter of its own that
    // answers at once, and the result global the mobile shells poll.
    await evaluateInPage(electronApp, `${origin}/stories`, `
      window.__onceSourcePicker = () => Promise.resolve(${JSON.stringify(forged)})
      window.__oncePickerResult = ${JSON.stringify(JSON.stringify(forged))}
      undefined
    `)

    const picker = await startPick(electronApp, window)
    // The real overlay opened, and the page's starter answered for nothing.
    expect(await pickState(window)).toBe("pending")

    // From its own world the page has the host element and nothing behind it.
    const reach = await evaluateInPage(electronApp, `${origin}/stories`, `
      (() => {
        const host = document.querySelector("once-source-picker")
        host.click()
        for (const type of ["click", "input", "mousedown", "mouseup"]) {
          host.dispatchEvent(new MouseEvent(type, { bubbles: true, composed: true }))
        }
        return { shadowRoot: host.shadowRoot, children: host.childNodes.length }
      })()
    `)
    expect(reach).toEqual({ shadowRoot: null, children: 0 })

    // Even a script holding the buttons could not press them: a synthetic
    // click on Save (with a savable form) or Cancel changes nothing.
    await picker.click(".row button")
    await picker.type(SOURCE_LINE, forged)
    await expect.poll(async () => (await picker.read(SAVE, "disabled"))[0]).toBe(false)
    await picker.scriptClick(SAVE)
    await picker.scriptClick(CANCEL)
    expect(await pickState(window)).toBe("pending")
    expect(await picker.present()).toBe(true)

    // The user's own click still ends it.
    await picker.click(CANCEL)
    expect(await window.evaluate(() => window.__oncePickResult)).toBe(null)
    await expect.poll(() => picker.present()).toBe(false)
  } finally {
    await closeApp(electronApp, userData)
  }
})

test("cancels the picker when the tab navigates away", async () => {
  const { electronApp, userData, window } = await launchApp()
  try {
    const tab = await openStoriesTab(window)
    await startPick(electronApp, window)

    await window.evaluate(
      ({ id, url }) => window.onceElectron.tabs.navigate(id, url),
      { id: tab.id, url: `${origin}/two` }
    )
    await expect(window.locator(".electron-tab-title")).toHaveText("Two")
    expect(await window.evaluate(() => window.__oncePickResult)).toBe(null)
  } finally {
    await closeApp(electronApp, userData)
  }
})

test("rejects picking on pages that are not HTTP", async () => {
  const { electronApp, userData, window } = await launchApp()
  try {
    const error = await window.evaluate(() =>
      window.onceElectron.tabs.startSourcePicker().then(
        () => null,
        (pickError) => pickError.message
      )
    )
    expect(error).toContain("HTTP or HTTPS")
  } finally {
    await closeApp(electronApp, userData)
  }
})
