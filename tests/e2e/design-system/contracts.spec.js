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
    ...known.controlSemantics,
    ...known.iconViewBox
  ]) {
    expect(entry.reason).toBeTruthy()
    expect(entry.phase).toMatch(/^\d+\.\d+$/)
    expect(entry.removeWhen).toBeTruthy()
  }
})

test("legacy control-semantic debt is explicit and cannot grow", async ({ page }) => {
  await page.goto(`${baseURL}/static/sidepanel.html`)
  const violations = await page.locator(
    "div.btn, #menu > .sub, [role='button']"
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
