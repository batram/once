const { test, expect } = require("@playwright/test")

const known = require("./known-failures.json")
const matrix = require("./renderer-matrix.json")
const { createServer } = require("./static-server")

let server
let baseURL

test.beforeAll(async () => {
  server = createServer()
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  baseURL = `http://127.0.0.1:${server.address().port}`
})

test.afterAll(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
})

test("renderer matrix names every Phase 0 surface", () => {
  expect(Object.keys(matrix)).toEqual([
    "shared",
    "extensions",
    "electron",
    "mobileWeb",
    "android",
    "ios",
    "readerAndPresenters"
  ])
  expect(matrix.shared.automated).toBe(true)
  expect(matrix.android.automated).toBe(false)
  expect(matrix.ios.automated).toBe(false)
})

test("known failures carry ownership and a deletion condition", () => {
  for (const entry of [
    ...known.platformOwnership,
    ...known.controlSemantics,
    ...known.iconViewBox
  ]) {
    expect(entry.reason).toBeTruthy()
    expect(entry.phase).toMatch(/^\d+\.\d+$/)
    expect(entry.removeWhen).toBeTruthy()
  }
})

test("the user layer overrides a default token on the same element", async ({ page }) => {
  await page.goto(`${baseURL}/static/sidepanel.html`)
  await expect.poll(() => page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--sp-2").trim()
  )).toBe("8px")

  await page.addStyleTag({
    content: "@layer user { :root { --sp-2: 19px; } }"
  })

  await expect.poll(() => page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--sp-2").trim()
  )).toBe("19px")
})

test("trusted stylesheets have no unlayered application rules", async ({ page }) => {
  await page.goto(`${baseURL}/static/sidepanel.html?target=mobile`)
  const violations = await page.evaluate(() => {
    const failures = []
    for (const sheet of document.styleSheets) {
      for (const rule of sheet.cssRules) {
        if (rule.constructor.name === "CSSImportRule" && !rule.layerName) {
          failures.push(`unlayered import ${rule.href}`)
        } else if (rule.constructor.name === "CSSStyleRule") {
          failures.push(`unlayered rule ${rule.selectorText}`)
        }
      }
    }
    return failures
  })
  expect(violations).toEqual([])
})

test("the platform layer overrides components without important", async ({ page }) => {
  await page.goto(`${baseURL}/static/sidepanel.html?target=mobile`)
  await expect(page.locator("#reading_menu_btn")).toHaveCSS("display", "flex")
})

// The test above proves the platform layer can win. It must not win over a
// component that declares its own box: layer order beats specificity, so a
// platform rule matching the `button` element silently replaces geometry the
// component owns, and no amount of specificity in layer(components) recovers
// it. Assert the exact properties a platform density rule must not take:
// spacing, border, background and declared size. The touch target is a
// separate contract and is asserted below.
// Height is deliberately absent. The platform touch baseline raises a short
// control to var(--touch), which is a contract in its own right and is asserted
// separately below; folding it in here would leave this test red after the
// visual baseline is correctly retargeted. Width stays, because it is the
// visual rule that inflates it: the horizontal padding floors the border box.
const ownedBox = {
  width: "30px",
  padding: "0px",
  margin: "0px",
  borderWidth: "0px",
  backgroundColor: "rgba(0, 0, 0, 0)"
}

test("a component-owned control keeps its declared box under the platform layer", async ({ page }) => {
  const pending = known.platformOwnership[0]
  test.fail(Boolean(pending), pending?.reason ?? "")
  await page.goto(`${baseURL}/static/sidepanel.html?target=mobile`)
  await page.addStyleTag({
    content: `@layer components {
      button.owns_its_box {
        width: 30px;
        height: 30px;
        padding: 0;
        margin: 0;
        border: 0;
        background: transparent;
      }
    }`
  })
  const actual = await page.evaluate(() => {
    const probe = document.createElement("button")
    probe.type = "button"
    probe.className = "owns_its_box"
    document.body.append(probe)
    const style = getComputedStyle(probe)
    return {
      width: style.width,
      padding: style.padding,
      margin: style.margin,
      borderWidth: style.borderWidth,
      backgroundColor: style.backgroundColor
    }
  })
  expect(actual).toEqual(ownedBox)
})

// Retargeting the visual baseline must not take the touch target with it: a
// control that owns its box still needs a reachable hit area on mobile.
test("the platform touch baseline reaches a control with no component box", async ({ page }) => {
  await page.goto(`${baseURL}/static/sidepanel.html?target=mobile`)
  const minHeight = await page.evaluate(() => {
    const probe = document.createElement("button")
    probe.type = "button"
    document.body.append(probe)
    return getComputedStyle(probe).minHeight
  })
  expect(minHeight).toBe("44px")
})

test("documented priority utilities retain their contracts", async ({ page }) => {
  await page.goto(`${baseURL}/static/sidepanel.html?target=mobile`)
  const result = await page.evaluate(() => {
    const hidden = document.createElement("div")
    hidden.className = "input_container"
    hidden.hidden = true
    hidden.style.display = "block"
    const visuallyHidden = document.createElement("span")
    visuallyHidden.className = "visually_hidden"
    document.body.append(hidden, visuallyHidden)
    const hiddenStyle = getComputedStyle(hidden)
    const visualStyle = getComputedStyle(visuallyHidden)
    return {
      hidden: hiddenStyle.display,
      visual: [
        visualStyle.position,
        visualStyle.width,
        visualStyle.height,
        visualStyle.overflow
      ]
    }
  })
  expect(result.hidden).toBe("none")
  expect(result.visual).toEqual(["absolute", "1px", "1px", "hidden"])
})

test("tokenized shared and mobile geometry retains its measured values", async ({ page }) => {
  await page.goto(`${baseURL}/static/sidepanel.html`)
  await expect(page.locator(".bar").first()).toHaveCSS("padding", "5px 15px")
  await expect(page.locator("#menu .heading").first()).toHaveCSS("padding", "5px")

  await page.goto(`${baseURL}/static/sidepanel.html?target=mobile`)
  await expect(page.locator("#mobile_filter_chips")).toHaveCSS("gap", "8px")
  await expect(page.locator("#mobile_filter_chips")).toHaveCSS(
    "padding",
    "8px 12px"
  )
  await expect(page.locator("#reload_stories_btn")).toHaveCSS("height", "44px")
})

test("legacy control-semantic debt is explicit and cannot grow", async ({ page }) => {
  await page.goto(`${baseURL}/static/sidepanel.html`)
  const violations = await page.locator(
    ".btn, .icon-btn, #menu > .sub, [role='button'], input[type='button']"
  ).evaluateAll((elements) => elements
    .filter((element) => {
      if (element instanceof HTMLButtonElement) return false
      const role = element.getAttribute("role")
      const focusable = element.tabIndex >= 0
      return role !== "button" || !focusable
    })
    .map((element) => {
      if (element.id) return `#${element.id}`
      const parent = element.parentElement
      const parentSelector = parent?.id
        ? `#${parent.id}`
        : parent?.classList.length
          ? `.${[...parent.classList].join(".")}`
          : parent?.tagName.toLowerCase()
      const ancestor = parent?.closest("[id]")
      const scopedParent = !parent?.id && ancestor
        ? `#${ancestor.id} ${parentSelector}`
        : parentSelector
      const classSelector = element.classList.length
        ? `.${[...element.classList].join(".")}`
        : element.tagName.toLowerCase()
      return `${scopedParent} > ${classSelector}`
    })
    .sort())
  expect(violations).toEqual(
    known.controlSemantics.map((entry) => entry.selector).sort()
  )
})

test("button semantics, accessible names, keyboard focus, and layout primitives hold", async ({ page }) => {
  await page.goto(`${baseURL}/static/sidepanel.html`)

  await expect(page.locator(".button").first()).toHaveJSProperty("tagName", "BUTTON")
  const unnamedIconButtons = await page.locator(".button--icon").evaluateAll((buttons) =>
    buttons
      .filter((button) => !button.getAttribute("aria-label") && !button.textContent?.trim())
      .map((button) => button.id || button.outerHTML)
  )
  expect(unnamedIconButtons).toEqual([])

  await page.locator("body").click({ position: { x: 1, y: 1 } })
  await page.keyboard.press("Tab")
  const focused = page.locator(":focus")
  await expect(focused).toHaveJSProperty("tagName", "BUTTON")
  await expect(focused).toHaveCSS("outline-style", "solid")

  for (const selector of [".row", ".cluster", ".toolbar"]) {
    const alignments = await page.locator(selector).evaluateAll((elements) =>
      elements.map((element) => getComputedStyle(element).alignItems)
    )
    expect(alignments.every((value) => value === "center")).toBe(true)
  }
})

test("mobile button controls retain the touch contract", async ({ page }) => {
  await page.goto(`${baseURL}/static/sidepanel.html?target=mobile`)
  const controls = page.locator(
    "#reload_stories_btn, #settings_menu_btn, #reading_menu_btn, #stories_menu_btn > .heading"
  )
  for (const control of await controls.all()) {
    await expect(control).toHaveCSS("min-height", "44px")
  }
})

test("declared icon and button contracts have measurable geometry", async ({ page }) => {
  await page.goto(`${baseURL}/static/sidepanel.html`)
  const violations = await page.evaluate(() => {
    const failures = []
    for (const icon of document.querySelectorAll(".icon")) {
      const bounds = icon.getBoundingClientRect()
      if (bounds.width === 0 || bounds.height === 0) {
        failures.push(`${stableSelector(icon)} has zero size`)
      } else if (Math.abs(bounds.width - bounds.height) > 0.1) {
        failures.push(`${stableSelector(icon)} is not square`)
      }
    }
    for (const button of document.querySelectorAll(".button")) {
      if (!(button instanceof HTMLButtonElement)) {
        failures.push(`${stableSelector(button)} is not a button`)
      }
      const icon = button.querySelector(".icon")
      if (!icon) continue
      const buttonBox = button.getBoundingClientRect()
      const iconBox = icon.getBoundingClientRect()
      const x = Math.abs(
        iconBox.left + iconBox.width / 2 -
        (buttonBox.left + buttonBox.width / 2)
      )
      const y = Math.abs(
        iconBox.top + iconBox.height / 2 -
        (buttonBox.top + buttonBox.height / 2)
      )
      if (button.children.length === 1 && (x > 0.5 || y > 0.5)) {
        failures.push(`${stableSelector(button)} icon offset ${x},${y}`)
      }
    }
    return failures

    function stableSelector(element) {
      if (element.id) return `#${element.id}`
      return element.classList.length
        ? `.${[...element.classList].join(".")}`
        : element.tagName.toLowerCase()
    }
  })
  expect(violations).toEqual([])
})
