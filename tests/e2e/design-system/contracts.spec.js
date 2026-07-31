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
  await expect(page.locator("#search_bar")).toHaveCSS("height", "39px")
  await expect(page.locator("#settings_panel .panel_titlebar")).toHaveCSS(
    "height",
    "39px"
  )
  await page.locator("#settings_panel .panel_titlebar").evaluate((bar) => {
    const toggle = document.createElement("button")
    toggle.className = "button structured_mode_toggle_topbar"
    toggle.type = "button"
    toggle.setAttribute("aria-label", "Edit as text")
    bar.append(toggle)
  })
  for (const button of await page.locator(
    "#settings_panel .panel_titlebar > button"
  ).all()) {
    await expect(button).toHaveCSS("height", "26px")
    await expect(button).toHaveCSS("min-height", "26px")
  }
  expect(await page.locator(".structured_mode_toggle_topbar").evaluate(
    (toggle) => ({
      before: getComputedStyle(toggle, "::before").height,
      after: getComputedStyle(toggle, "::after").height,
      iconShadow: getComputedStyle(toggle, "::before").textShadow
    })
  )).toEqual({
    before: "24px",
    after: "24px",
    iconShadow: "rgb(0, 0, 0) 0px 1px 0px"
  })
  await expect(page.locator("#search_bar .collapsebutton_icon")).toHaveCSS(
    "color",
    "rgb(107, 99, 87)"
  )
  for (const selector of [
    "#search_bar .collapsebutton",
    "#settings_panel .collapsebutton"
  ]) {
    await expect(page.locator(selector)).toHaveCSS("height", "26px")
    await expect(page.locator(selector)).toHaveCSS("padding", "0px 2px")
    await expect(page.locator(selector)).toHaveCSS(
      "font-size",
      "16px"
    )
    await expect(page.locator(selector)).toHaveCSS(
      "border-top-color",
      "rgb(179, 179, 179)"
    )
    await expect(page.locator(selector)).toHaveCSS(
      "border-bottom-color",
      "rgb(179, 179, 179)"
    )
  }
  await page.locator("#settings_panel").evaluate((panel) => {
    for (const section of ["sources", "filters", "redirects"]) {
      const input = document.createElement("input")
      input.type = "search"
      input.dataset.testid = `${section}-list-search`
      panel.append(input)
    }
  })
  for (const selector of [
    "#settings_search",
    "#couch_input",
    "#cache_time_input",
    '[data-testid="sources-list-search"]',
    '[data-testid="filters-list-search"]',
    '[data-testid="redirects-list-search"]'
  ]) {
    await expect(page.locator(selector)).toHaveCSS(
      "background-color",
      "rgb(255, 255, 255)"
    )
  }
  await expect(page.locator("#search_scope")).toHaveCSS("padding-left", "0px")
  await expect(page.locator("#searchfield")).toHaveCSS("padding-left", "70px")
  await expect(page.locator("#cancel_search_btn .icon")).toHaveCSS(
    "width",
    "9px"
  )
  await expect(page.locator("#couch_input")).toHaveCSS("padding-right", "35px")
  await expect(page.locator(".couch-highlights")).toHaveCSS("right", "35px")
  await expect.poll(async () => {
    const scope = await page.locator("#search_scope").boundingBox()
    const field = await page.locator("#searchfield").boundingBox()
    return Math.round(scope.x - field.x)
  }).toBe(8)
  await page.goto(`${baseURL}/static/sidepanel.html?target=webext`)
  await expect.poll(async () => {
    const collapse = await page.locator(
      "#search_bar > .collapsebutton"
    ).boundingBox()
    const field = await page.locator("#searchfield").boundingBox()
    return Math.round(field.x - (collapse.x + collapse.width))
  }).toBeGreaterThanOrEqual(0)
  await expect(page.locator("#search_bar")).toHaveCSS("padding-right", "8px")
  await expect.poll(async () => {
    const bar = await page.locator("#search_bar").boundingBox()
    const reload = await page.locator("#reload_stories_btn").boundingBox()
    return Math.round(bar.x + bar.width - (reload.x + reload.width))
  }).toBe(8)
  await page.goto(`${baseURL}/static/sidepanel.html`)
  await expect(page.locator("#menu .heading").first()).toHaveCSS("padding", "6px")

  await page.goto(`${baseURL}/static/sidepanel.html?target=mobile`)
  await expect(page.locator("#mobile_filter_chips")).toHaveCSS("gap", "8px")
  await expect(page.locator("#mobile_filter_chips")).toHaveCSS(
    "padding",
    "8px 12px"
  )
  await expect(page.locator("#reload_stories_btn")).toHaveCSS("height", "44px")
  await expect(page.locator("#search_bar")).not.toHaveCSS("height", "39px")
  await expect(page.locator("#searchfield")).toHaveCSS("position", "static")
  await expect(page.locator("#cancel_search_btn .icon")).toHaveCSS(
    "width",
    "16px"
  )
  await expect(page.locator("#couch_input")).toHaveCSS("padding-right", "48px")
  await expect(page.locator(".couch-highlights")).toHaveCSS("right", "48px")
  await expect(page.locator("#couch_toggle")).toHaveCSS("width", "44px")
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

test("structured Settings rows use their light highlight tint", async ({ page }) => {
  await page.goto(`${baseURL}/static/sidepanel.html`)
  await page.locator("body").evaluate((body) => {
    body.insertAdjacentHTML(
      "beforeend",
      '<div class="structured_row"><button type="button">Example</button></div>'
    )
  })

  const row = page.locator(".structured_row").last()
  await row.hover()
  const colours = await row.evaluate((element) => {
    const probe = document.createElement("div")
    probe.style.background = "var(--structured-row-highlight-bg-color)"
    document.body.append(probe)
    const result = {
      row: getComputedStyle(element).backgroundColor,
      preset: getComputedStyle(probe).backgroundColor,
      old: getComputedStyle(document.documentElement)
        .getPropertyValue("--selected_bg_color")
        .trim()
    }
    probe.remove()
    return result
  })
  expect(colours.row).toBe(colours.preset)
  expect(colours.row).not.toBe(colours.old)
})

test("structured group and row menus share the compact desktop box", async ({ page }) => {
  await page.goto(`${baseURL}/static/sidepanel.html`)
  await page.locator("body").evaluate((body) => {
    body.insertAdjacentHTML("beforeend", `
      <details class="structured_group" open>
        <summary>
          <span class="structured_group_actions">
            <button class="structured_group_menu" type="button">&#8942;</button>
          </span>
        </summary>
      </details>
      <div class="structured_row">
        <button class="structured_row_menu" type="button">&#8942;</button>
      </div>
    `)
  })

  await page.locator(".structured_group > summary").hover()
  const groupMenu = page.locator(".structured_group_menu").last()
  const rowMenu = page.locator(".structured_row_menu").last()
  for (const menu of [groupMenu, rowMenu]) {
    await expect(menu).toHaveCSS("width", "22px")
    await expect(menu).toHaveCSS("height", "22px")
    await expect(menu).toHaveCSS("padding", "0px")
    await expect(menu).toHaveCSS("border-width", "1px")
    await expect(menu).toHaveCSS("border-radius", "2px")
  }
})

test("shared inline save and cancel glyphs have balanced visual weight", async ({ page }) => {
  await page.goto(`${baseURL}/static/sidepanel.html`)
  await page.locator("body").evaluate((body) => {
    body.insertAdjacentHTML("beforeend", `
      <button class="structured_inline_action" type="button" aria-label="Save">
        <span class="glyph_check" aria-hidden="true"></span>
      </button>
      <button class="structured_inline_action" type="button" aria-label="Cancel">
        <span class="glyph_cross" aria-hidden="true"></span>
      </button>
    `)
  })

  const actions = page.locator(".structured_inline_action")
  for (const action of await actions.all()) {
    await expect(action).toHaveCSS("width", "22px")
    await expect(action).toHaveCSS("height", "22px")
    await expect(action).toHaveCSS("cursor", "pointer")
  }
  await expect(page.locator(".glyph_check").last()).toHaveCSS("width", "10.5px")
  await expect(page.locator(".glyph_cross").last()).toHaveCSS("width", "11px")
  await expect(page.locator(".glyph_cross").last()).toHaveCSS("height", "11px")
  const crossBar = await page.locator(".glyph_cross").last().evaluate((glyph) => {
    const style = getComputedStyle(glyph, "::before")
    return { width: style.width, height: style.height }
  })
  expect(crossBar).toEqual({ width: "11px", height: "1px" })
})

test("the swipe footer keeps its action cluster on the right", async ({ page }) => {
  await page.goto(`${baseURL}/static/sidepanel.html`)
  await page.locator("body").evaluate((body) => {
    body.insertAdjacentHTML("beforeend", `
      <div class="swipe_footer row" style="width: 400px">
        <span class="swipe_save_status">all changes saved</span>
        <button class="button" type="button">undo</button>
        <button class="button" type="button">reset to defaults</button>
      </div>
    `)
  })

  const positions = await page.locator(".swipe_footer").last().evaluate((footer) => {
    const status = footer.querySelector(".swipe_save_status")
    const undo = footer.querySelector("button")
    const reset = footer.querySelector("button:last-child")
    return {
      gapAfterStatus:
        undo.getBoundingClientRect().left - status.getBoundingClientRect().right,
      resetAtRight:
        footer.getBoundingClientRect().right - reset.getBoundingClientRect().right
    }
  })
  expect(positions.gapAfterStatus).toBeGreaterThan(0)
  expect(positions.resetAtRight).toBe(0)
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
