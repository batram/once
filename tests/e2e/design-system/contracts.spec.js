const { test, expect } = require("@playwright/test")
const fs = require("node:fs")
const path = require("node:path")

const known = require("./known-failures.json")
const matrix = require("./renderer-matrix.json")
const { createServer, root } = require("./static-server")

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

test("only the mobile platform exposes the Reading menu", async ({ page }) => {
  await page.goto(`${baseURL}/static/sidepanel.html`)
  await expect(page.locator("#reading_menu_btn")).toBeHidden()

  await page.goto(`${baseURL}/static/sidepanel.html?target=electron`)
  await expect(page.locator("#reading_menu_btn")).toBeHidden()
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
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto(`${baseURL}/static/sidepanel.html?target=mobile`)
  const result = await page.evaluate(() => {
    // One global rule replaced fifteen per-selector ones, so the probes are the
    // three ways an element used to escape it: an inline style, a component
    // declaring display in layer(components), and a platform sheet declaring it
    // in layer(platform) — the last of which no specificity could beat.
    const hidden = document.createElement("div")
    hidden.className = "input_container"
    hidden.hidden = true
    hidden.style.display = "block"
    const hiddenComponent = document.createElement("div")
    hiddenComponent.className = "status_indicator"
    hiddenComponent.hidden = true
    const hiddenPlatform = document.createElement("div")
    hiddenPlatform.className = "story"
    hiddenPlatform.hidden = true
    document.body.append(hiddenComponent, hiddenPlatform)
    const visuallyHidden = document.createElement("span")
    visuallyHidden.className = "visually_hidden"
    const dragRoot = document.createElement("div")
    dragRoot.className = "active_drag"
    const dragChild = document.createElement("span")
    dragChild.style.pointerEvents = "auto"
    dragRoot.append(dragChild)
    const motionProbe = document.createElement("div")
    motionProbe.style.transitionDuration = "10s"
    document.body.append(hidden, visuallyHidden, dragRoot, motionProbe)
    const hiddenStyle = getComputedStyle(hidden)
    const visualStyle = getComputedStyle(visuallyHidden)
    return {
      hidden: hiddenStyle.display,
      hiddenComponent: getComputedStyle(hiddenComponent).display,
      hiddenPlatform: getComputedStyle(hiddenPlatform).display,
      dragPointerEvents: getComputedStyle(dragChild).pointerEvents,
      reducedTransition: getComputedStyle(motionProbe).transitionDuration,
      visual: [
        visualStyle.position,
        visualStyle.width,
        visualStyle.height,
        visualStyle.overflow
      ]
    }
  })
  expect(result.hidden).toBe("none")
  expect(result.hiddenComponent).toBe("none")
  expect(result.hiddenPlatform).toBe("none")
  expect(result.dragPointerEvents).toBe("none")
  expect(result.reducedTransition).toBe("1e-05s")
  expect(result.visual).toEqual(["absolute", "1px", "1px", "hidden"])
})

test("tokenized shared and mobile geometry resolves to the public scale", async ({ page }) => {
  await page.goto(`${baseURL}/static/sidepanel.html`)
  // .bar first resolves to #search_bar, which cancels the bar's inline padding
  // so the collapse control can meet the menu panel edge (see search.css). The
  // block padding is the tokenized value; the inline value is deliberately 0.
  await expect(page.locator(".bar").first()).toHaveCSS("padding", "5px 0px")
  await expect(page.locator("#menu .heading").first()).toHaveCSS("padding", "6px")

  await page.goto(`${baseURL}/static/sidepanel.html?target=mobile`)
  await expect(page.locator("#mobile_filter_chips")).toHaveCSS("gap", "8px")
  await expect(page.locator("#mobile_filter_chips")).toHaveCSS(
    "padding",
    "8px 12px"
  )
  await expect(page.locator("#reload_stories_btn")).toHaveCSS("height", "44px")
})

test("shell scopes express their geometry through the public scale", async ({ page }) => {
  await page.goto(`${baseURL}/static/sidepanel.html`)

  await page.locator("body").evaluate((body) => {
    body.insertAdjacentHTML("beforeend", `
      <input id="urlfield">
      <div id="status_surfaces">
        <div id="status_bar"></div>
        <div class="status_issue_bubble">
          <button class="status_issue_content"></button>
        </div>
      </div>
      <div id="status_dock"></div>
      <div id="hover_url"></div>
    `)
  })
  await expect(page.locator("#urlfield")).toHaveCSS("padding-left", "8px")
  await expect(page.locator("#status_surfaces")).toHaveCSS("gap", "6px")
  await expect(page.locator("#status_bar")).toHaveCSS("font-size", "11px")
  await expect(page.locator("#status_bar")).toHaveCSS("padding", "6px 12px 6px 8px")
  await expect(page.locator("#status_dock")).toHaveCSS("margin-bottom", "32px")
  await expect(page.locator("#status_dock")).toHaveCSS(
    "border-radius",
    "14px 0px 0px 14px"
  )
  await expect(page.locator(".status_issue_bubble")).toHaveCSS("font-size", "11px")
  await expect(page.locator(".status_issue_content")).toHaveCSS(
    "padding",
    "6px 8px"
  )
  await expect(page.locator("#hover_url")).toHaveCSS("font-size", "11px")

  await page.locator("body").evaluate((body) => {
    body.insertAdjacentHTML("beforeend", `
      <div class="once-confirm-dialog">
        <p>Confirm</p>
        <input class="once-confirm-dialog__input">
        <div class="once-confirm-dialog__actions">
          <button type="button" class="button">OK</button>
        </div>
      </div>
    `)
  })
  const dialog = page.locator(".once-confirm-dialog")
  await expect(dialog).toHaveCSS("padding", "16px")
  await expect(dialog).toHaveCSS("border-radius", "6px")
  await expect(dialog.locator("p")).toHaveCSS("margin-bottom", "16px")
  await expect(dialog.locator("input")).toHaveCSS("padding", "8px")
  await expect(dialog.locator(".once-confirm-dialog__actions")).toHaveCSS("gap", "6px")
  await expect(dialog.locator("button")).toHaveCSS("padding", "6px 8px")
})

test("the standalone Electron error page uses the tokens it declares", async ({ page }) => {
  const css = fs.readFileSync(
    path.join(root, "apps", "electron", "src", "browser", "error-page.css"),
    "utf8"
  )
  await page.setContent(`
    <div class="error-card">
      <div class="error-heading">
        <span class="error-icon"></span>
        <div>
          <h1>Failed</h1>
          <p class="error-message">Error</p>
        </div>
      </div>
      <div class="url-box">https://example.test</div>
      <a class="retry">Retry</a>
    </div>
  `)
  await page.addStyleTag({ content: css })

  await expect(page.locator("body")).toHaveCSS("padding", "24px")
  await expect(page.locator(".error-card")).toHaveCSS("padding", "24px")
  await expect(page.locator(".error-card")).toHaveCSS("border-radius", "4px")
  await expect(page.locator(".error-heading")).toHaveCSS("gap", "12px")
  await expect(page.locator(".error-heading")).toHaveCSS("margin-bottom", "16px")
  await expect(page.locator("h1")).toHaveCSS("font-size", "16px")
  await expect(page.locator(".error-message")).toHaveCSS("font-size", "12px")
  await expect(page.locator(".url-box")).toHaveCSS("padding", "8px")
  await expect(page.locator(".retry")).toHaveCSS("padding", "6px 12px")
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
  await page.locator("body").evaluate((body) => {
    body.insertAdjacentHTML("beforeend", `
      <div data-testid="row-contract" class="row"></div>
      <div data-testid="stack-contract" class="stack"></div>
      <div data-testid="cluster-contract" class="cluster"></div>
      <div data-testid="toolbar-contract" class="toolbar"></div>
    `)
  })

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

  await expect(page.getByTestId("row-contract")).toHaveCSS("flex-flow", "row nowrap")
  await expect(page.getByTestId("row-contract")).toHaveCSS("align-items", "center")
  await expect(page.getByTestId("stack-contract")).toHaveCSS("flex-flow", "column nowrap")
  await expect(page.getByTestId("cluster-contract")).toHaveCSS("flex-flow", "row wrap")
  await expect(page.getByTestId("cluster-contract")).toHaveCSS("align-items", "center")
  await expect(page.getByTestId("toolbar-contract")).toHaveCSS("align-items", "center")
  await expect(page.getByTestId("toolbar-contract")).toHaveCSS("justify-content", "flex-start")
})

test("ordinary desktop Settings actions share the dense button skin", async ({ page }) => {
  await page.goto(`${baseURL}/static/sidepanel.html`)
  const action = page.locator("#cache_time_save")
  await expect(action).toHaveClass(/\bbutton\b/)
  await expect(action).toHaveCSS("box-sizing", "border-box")
  await expect(action).toHaveCSS("height", "22px")
  await expect(action).toHaveCSS("min-height", "22px")
  await expect(action).toHaveCSS("padding", "0px 8px")
  await expect(action).toHaveCSS("border-width", "1px")
  await expect(action).toHaveCSS("font-size", "12px")
  await expect(action).toHaveCSS("line-height", "20px")
})

test("an embedded story keeps its component-owned action boxes in Settings", async ({ page }) => {
  await page.goto(`${baseURL}/static/sidepanel.html`)
  await page.locator("#settings_panel").evaluate((panel) => {
    panel.insertAdjacentHTML("beforeend", `
      <article class="story">
        <div class="button_group">
          <button type="button" class="button filter_btn" aria-label="Filter">
            <span class="icon icon--chrome icon--filter" aria-hidden="true"></span>
          </button>
          <button type="button" class="button read_btn" aria-label="Read"></button>
        </div>
      </article>
    `)
  })

  for (const action of await page.locator("#settings_panel .story .button").all()) {
    await expect(action).toHaveCSS("box-sizing", "content-box")
    await expect(action).toHaveCSS("height", "16px")
    await expect(action).toHaveCSS("padding", "2px")
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

test("Settings shell defaults yield to mobile navigation geometry", async ({ page }) => {
  await page.goto(`${baseURL}/static/sidepanel.html`)
  await page.locator("#settings_index").evaluate((index) => {
    index.insertAdjacentHTML("beforeend", `
      <button type="button" class="settings_section_row">
        <span class="settings_section_row_text">Sources</span>
        <span class="settings_section_summary">5 configured</span>
        <span class="settings_section_arrow">â€º</span>
      </button>
    `)
  })
  const desktopRow = page.locator(".settings_section_row").first()
  await expect(desktopRow).toHaveCSS("height", "28px")
  await expect(desktopRow).toHaveCSS("font-size", "13px")
  await expect(page.locator(".settings_container")).toHaveCSS("overflow", "hidden")
  await expect(page.locator("#settings_index")).toHaveCSS("padding", "8px")

  await page.goto(`${baseURL}/static/sidepanel.html?target=mobile`)
  await page.locator("#settings_index").evaluate((index) => {
    index.insertAdjacentHTML("beforeend", `
      <button type="button" class="settings_section_row">
        <span class="settings_section_row_text">Sources</span>
        <span class="settings_section_summary">5 configured</span>
        <span class="settings_section_arrow">â€º</span>
      </button>
    `)
  })
  const mobileRow = page.locator(".settings_section_row").first()
  await expect(mobileRow).toHaveCSS("height", "auto")
  await expect(mobileRow).toHaveCSS("min-height", "44px")
  await expect(mobileRow).toHaveCSS("font-size", "14px")
  await expect(mobileRow.locator(".settings_section_summary")).toHaveCSS("font-size", "14px")
  await expect(mobileRow.locator(".settings_section_arrow")).toHaveCSS("font-size", "14px")
  await expect(page.locator(".settings_container")).toHaveCSS("overflow", "auto")
  await expect(page.locator("#settings_index")).toHaveCSS("padding", "12px")
})

test("declared icon and button contracts have measurable geometry", async ({ page }) => {
  await page.goto(`${baseURL}/static/sidepanel.html`)
  const violations = await page.evaluate(() => {
    const failures = []
    for (const icon of document.querySelectorAll(".icon")) {
      const bounds = icon.getBoundingClientRect()
      if (icon.getClientRects().length === 0) continue
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
      if (button.classList.contains("button--icon") && (x > 0.5 || y > 0.5)) {
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

test("active-state colour is confined to icon masks", async ({ page }) => {
  await page.goto(`${baseURL}/static/sidepanel.html`)
  await page.locator("body").evaluate((body) => {
    body.insertAdjacentHTML(
      "beforeend",
      '<div id="active-colour-fixture" class="active">' +
        '<span class="icon icon--chrome icon--star" aria-hidden="true"></span>' +
        "<span>Active text</span></div>"
    )
  })
  const fixture = page.locator("#active-colour-fixture")
  await expect(fixture.locator(".icon")).toHaveCSS("color", "rgb(0, 192, 0)")
  await expect(fixture.locator("span").last()).not.toHaveCSS("color", "rgb(0, 192, 0)")
})
