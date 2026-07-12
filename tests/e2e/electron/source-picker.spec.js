const { test, expect } = require("@playwright/test")
const { closeApp, launchApp, startPageServer } = require("./electron-harness")

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

test("builds a geny source from picked selectors and saves it", async () => {
  const { electronApp, userData, window } = await launchApp()
  try {
    const [tab] = await window.evaluate(() => window.onceElectron.tabs.getAll())
    await window.evaluate(
      ({ id, url }) => window.onceElectron.tabs.navigate(id, url),
      { id: tab.id, url: `${origin}/stories` }
    )
    await expect(window.locator(".electron-tab-title")).toHaveText("Stories")

    // Start the picker through the settings button (full UI flow).
    await window.evaluate(() => {
      document.querySelector("#pick_source_button").click()
    })

    // The overlay appears inside the remote page with pick mode armed.
    await expect.poll(() => evaluateInPage(electronApp, `${origin}/stories`, `
      Boolean(document.querySelector("once-source-picker"))
    `)).toBe(true)

    // Fill the selectors as if typed manually and save.
    const preview = await evaluateInPage(electronApp, `${origin}/stories`, `
      (async () => {
        const shadow = document.querySelector("once-source-picker").shadowRoot
        const inputs = shadow.querySelectorAll(".row input[type=text]")
        const values = ["li.story", "a.title", "a.title", "", "span.tag"]
        inputs.forEach((input, index) => {
          input.value = values[index]
          input.dispatchEvent(new Event("input"))
        })
        await new Promise((resolve) => setTimeout(resolve, 400))
        const stories = shadow.querySelectorAll("#preview .story")
        return {
          parsed: shadow.querySelector("#preview .summary").textContent,
          first: stories[0] ? stories[0].textContent : "",
          saveDisabled: shadow.querySelector("#actions .save").disabled
        }
      })()
    `)
    expect(preview.parsed).toContain("3 stories parsed")
    expect(preview.first).toContain("Story One")
    expect(preview.first).toContain("tag-one")
    expect(preview.saveDisabled).toBe(false)

    await evaluateInPage(electronApp, `${origin}/stories`, `
      document.querySelector("once-source-picker")
        .shadowRoot.querySelector("#actions .save").click()
    `)

    // The sanitized source line lands in the story sources settings.
    await expect.poll(() =>
      window.evaluate(() => document.querySelector("#sources_area").value)
    ).toContain("geny:§§")
    const sources = await window.evaluate(
      () => document.querySelector("#sources_area").value
    )
    const line = sources.split("\n").find((entry) => entry.startsWith("geny:"))
    const [, confJson, url] = line.split("§§")
    expect(url).toBe(`${origin}/stories`)
    expect(JSON.parse(confJson)).toEqual({
      stories: { sel: "li.story", all: true },
      link: { sel: "a.title", component: "href" },
      title: { sel: "a.title", component: "innerText", processors: ["trim"] },
      tags: [{ elements: { text: { sel: "span.tag", component: "innerText" } } }]
    })

    // The overlay is gone after saving.
    await expect.poll(() => evaluateInPage(electronApp, `${origin}/stories`, `
      Boolean(document.querySelector("once-source-picker"))
    `)).toBe(false)
  } finally {
    await closeApp(electronApp, userData)
  }
})

test("picks stories, link, and title by clicking page elements", async () => {
  const { electronApp, userData, window } = await launchApp()
  try {
    const [tab] = await window.evaluate(() => window.onceElectron.tabs.getAll())
    await window.evaluate(
      ({ id, url }) => window.onceElectron.tabs.navigate(id, url),
      { id: tab.id, url: `${origin}/stories` }
    )
    await expect(window.locator(".electron-tab-title")).toHaveText("Stories")

    await window.evaluate(() => {
      window.__oncePickResult = window.onceElectron.tabs.startSourcePicker()
    })
    await expect.poll(() => evaluateInPage(electronApp, `${origin}/stories`, `
      Boolean(document.querySelector("once-source-picker"))
    `)).toBe(true)

    // Pick mode starts on the stories field and advances to link and title
    // as elements are clicked; every click lands on the second title link.
    const values = await evaluateInPage(electronApp, `${origin}/stories`, `
      (async () => {
        const shadow = document.querySelector("once-source-picker").shadowRoot
        const catcher = shadow.querySelector("#catcher")
        const clickTitle = () => {
          const rect = document.querySelectorAll("a.title")[1].getBoundingClientRect()
          catcher.dispatchEvent(new MouseEvent("click", {
            clientX: rect.x + 4,
            clientY: rect.y + 4,
            bubbles: true
          }))
        }
        for (let i = 0; i < 3; i++) {
          clickTitle()
          await new Promise((resolve) => setTimeout(resolve, 250))
        }
        return Array.from(
          shadow.querySelectorAll(".row input[type=text]"),
          (input) => input.value
        )
      })()
    `)
    expect(values).toEqual(["li.story", "a.title", "a.title", "", ""])

    await evaluateInPage(electronApp, `${origin}/stories`, `
      document.querySelector("once-source-picker")
        .shadowRoot.querySelector("#actions .save").click()
    `)
    const line = await window.evaluate(() => window.__oncePickResult)
    expect(line).toContain("geny:§§")
    expect(JSON.parse(line.split("§§")[1])).toEqual({
      stories: { sel: "li.story", all: true },
      link: { sel: "a.title", component: "href" },
      title: { sel: "a.title", component: "innerText", processors: ["trim"] }
    })
  } finally {
    await closeApp(electronApp, userData)
  }
})

test("cancels the picker when the tab navigates away", async () => {
  const { electronApp, userData, window } = await launchApp()
  try {
    const [tab] = await window.evaluate(() => window.onceElectron.tabs.getAll())
    await window.evaluate(
      ({ id, url }) => window.onceElectron.tabs.navigate(id, url),
      { id: tab.id, url: `${origin}/stories` }
    )
    await expect(window.locator(".electron-tab-title")).toHaveText("Stories")

    await window.evaluate(() => {
      window.__oncePickResult = window.onceElectron.tabs.startSourcePicker()
    })
    await expect.poll(() => evaluateInPage(electronApp, `${origin}/stories`, `
      Boolean(document.querySelector("once-source-picker"))
    `)).toBe(true)

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
