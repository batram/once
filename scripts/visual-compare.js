"use strict"

const childProcess = require("node:child_process")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { chromium, devices, expect } = require("@playwright/test")

const {
  closeApp,
  launchApp,
  openPanel,
  openSettingsSection,
  seedLocalSource,
  startPageServer
} = require("../tests/e2e/electron/electron-harness")
const storyFixture = require("../tests/e2e/shared/story-fixture")
const {
  startTestServer
} = require("../tests/e2e/mobile/test-server-process")
const {
  gotoMobileApp,
  reloadMobileApp
} = require("../tests/e2e/mobile/helpers/mobile-app")
const {
  openSettingsSection: openMobileSettingsSection,
  saveSourcesAndWait
} = require("../tests/e2e/mobile/helpers/settings")
const { dragStory } = require("../tests/e2e/mobile/helpers/swipe")

const repoRoot = path.resolve(__dirname, "..")
const defaultOutput = path.join(repoRoot, "artifacts", "app-visual-review")
const themes = ["light", "dark"]
const settingsSections = [
  "sources",
  "filters",
  "redirects",
  "sync",
  "theme",
  "swipe",
  "cache",
  "errors",
  "about"
]

const structuralCollectorConfig = Object.freeze({
  repeatLimit: 12,
  maxElements: 500,
  excludedSubtrees: ["story-item", ".once-reader-host"],
  excludedTags: [
    "SCRIPT", "STYLE", "LINK", "META", "TEMPLATE", "NOSCRIPT",
    "SOURCE", "TRACK"
  ]
})

function buildImageNames(targets) {
  return targets.flatMap(target => themes.flatMap(theme => [
    `${target}-${theme}-stories.png`,
    `${target}-${theme}-story-states.png`,
    `${target}-${theme}-swipe-left-stage1.png`,
    `${target}-${theme}-swipe-right-stage2.png`,
    `${target}-${theme}-settings-index.png`,
    ...settingsSections.map(section =>
      `${target}-${theme}-settings-${section}.png`
    ),
    `${target}-${theme}-reading.png`
  ]))
}

function styleSnapshotName(imageName) {
  return imageName.replace(/\.png$/, ".styles.json")
}

function parseArgs(argv) {
  const options = {
    build: true,
    electron: true,
    mobile: true,
    output: defaultOutput,
    ref: null,
    refOnly: false
  }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === "--skip-build") options.build = false
    else if (value === "--electron-only") options.mobile = false
    else if (value === "--mobile-only") options.electron = false
    else if (value === "--ref") {
      options.ref = argv[++index]
      if (!options.ref) throw new Error("--ref requires a Git commit-ish")
    }
    else if (value === "--ref-only") options.refOnly = true
    else if (value === "--output") {
      const output = argv[++index]
      if (!output) throw new Error("--output requires a directory")
      options.output = path.resolve(repoRoot, output)
    } else if (value === "--help" || value === "-h") {
      options.help = true
    } else {
      throw new Error(`Unknown option: ${value}`)
    }
  }
  return options
}

function runNpm(npmArgs, cwd = repoRoot, env = process.env) {
  const npmCli = process.env.npm_execpath
  const command = npmCli ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm"
  const args = npmCli ? [npmCli, ...npmArgs] : npmArgs
  const result = childProcess.spawnSync(command, args, {
    cwd,
    env,
    stdio: "inherit",
    windowsHide: true
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`npm ${npmArgs.join(" ")} failed with exit ${result.status}`)
  }
}

function runGit(args, options = {}) {
  const result = childProcess.spawnSync("git", args, {
    cwd: options.cwd || repoRoot,
    encoding: "utf8",
    stdio: options.quiet ? "pipe" : "inherit",
    windowsHide: true
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const detail = options.quiet
      ? `\n${result.stdout || ""}${result.stderr || ""}`
      : ""
    throw new Error(`git ${args.join(" ")} failed${detail}`)
  }
  return (result.stdout || "").trim()
}

function resolveRef(ref) {
  return runGit(["rev-parse", "--verify", `${ref}^{commit}`], { quiet: true })
}

function historicalRunName(sha) {
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    throw new Error(`Invalid commit SHA for visual history: ${sha}`)
  }
  return sha.toLowerCase()
}

function historicalRunComplete(runOutput, imageNames, sha) {
  const manifestPath = path.join(runOutput, "manifest.json")
  if (!fs.existsSync(manifestPath)) return false
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
    if (manifest.sha !== sha) return false
    return imageNames.every(name =>
      fs.existsSync(path.join(runOutput, name)) &&
      fs.existsSync(path.join(runOutput, styleSnapshotName(name)))
    )
  } catch {
    return false
  }
}

function prepareOutput(output, imageNames) {
  const current = path.join(output, "current")
  const baseline = path.join(output, "baseline")
  fs.mkdirSync(current, { recursive: true })
  fs.mkdirSync(baseline, { recursive: true })
  for (const name of imageNames) {
    for (const artifact of [name, styleSnapshotName(name)]) {
      const previous = path.join(current, artifact)
      const saved = path.join(baseline, artifact)
      if (fs.existsSync(previous)) fs.copyFileSync(previous, saved)
    }
  }
  const selectedTargets = new Set(
    imageNames.map(name => name.slice(0, name.indexOf("-")))
  )
  const activeNames = new Set(imageNames.flatMap(name => [
    name,
    styleSnapshotName(name)
  ]))
  for (const entry of fs.readdirSync(baseline)) {
    const target = entry.slice(0, entry.indexOf("-"))
    if ((entry.endsWith(".png") || entry.endsWith(".styles.json")) &&
        selectedTargets.has(target) &&
        !activeNames.has(entry)) {
      fs.rmSync(path.join(baseline, entry))
    }
  }
  for (const name of imageNames) {
    fs.rmSync(path.join(current, name), { force: true })
    fs.rmSync(path.join(current, styleSnapshotName(name)), { force: true })
  }
  return { current, baseline }
}

async function settleImages(page) {
  await page.locator("img").evaluateAll(images =>
    Promise.all(images.map(image => image.decode().catch(() => undefined)))
  )
  await page.evaluate(() => document.fonts?.ready)
}

async function computedStyleSnapshot(page) {
  // Named rather than passed inline so its structure-exception key stays put.
  // check-structure.js keys an unnamed function by the line it starts on, so an
  // inline callback's exception would silently stop applying the first time
  // anything above it moved.
  const collectStyles = (collectorConfig) => {
    const selectors = [
      "body",
      "#left_panel",
      "#menu",
      "#search_bar",
      "#stories_panel",
      "#stories",
      "story-item",
      "story-item .data",
      "story-item .title",
      "story-item .info",
      "story-item .type",
      "story-item .tags_container",
      "story-item .tag",
      "story-item .button_group",
      "story-item .menu_btn",
      ".bb_slide",
      ".bb_slide .swipe_left",
      ".bb_slide .swipe_right",
      "#settings_panel",
      "#settings_sections",
      ".settings_section",
      ".settings_block",
      ".structured_settings",
      "#reading_panel",
      "#reading_content",
      ".once-reader-host"
    ]
    const properties = [
      "display", "position", "inset", "top", "right", "bottom", "left",
      "z-index", "box-sizing", "width", "height", "min-width", "min-height",
      "max-width", "max-height", "margin", "margin-block", "margin-inline",
      "padding", "padding-block", "padding-inline", "border",
      "border-width", "border-style", "border-color", "border-radius",
      "outline", "background", "background-color", "background-image",
      "color", "opacity", "box-shadow", "font-family", "font-size",
      "font-style", "font-weight", "line-height", "letter-spacing",
      "text-align", "text-decoration", "text-overflow", "white-space",
      "overflow", "overflow-x", "overflow-y", "visibility",
      "flex", "flex-basis", "flex-direction", "flex-grow", "flex-shrink",
      "flex-wrap", "align-content", "align-items", "align-self",
      "justify-content", "justify-items", "justify-self", "gap",
      "row-gap", "column-gap", "grid-template-columns",
      "grid-template-rows", "grid-auto-flow", "transform",
      "transform-origin", "transition", "animation", "cursor",
      "pointer-events", "touch-action", "object-fit", "aspect-ratio",
      "appearance", "accent-color", "font", "vertical-align",
      "inline-size", "block-size", "min-inline-size", "max-inline-size"
    ]
    const computed = (element, pseudo = null) => {
      const style = getComputedStyle(element, pseudo)
      const selected = pseudo
        ? [
          "content", "display", "position", "inset", "width", "height",
          "border", "border-radius", "background", "color", "opacity",
          "box-shadow", "transform", "transition", "animation"
        ]
        : properties
      return Object.fromEntries(selected.map(property => [
        property,
        style.getPropertyValue(property)
      ]))
    }
    const describe = (element, index, identity = {}) => {
      const rect = element.getBoundingClientRect()
      return {
        index,
        ...identity,
        tag: element.tagName.toLowerCase(),
        id: element.id || null,
        classes: [...element.classList],
        testId: element.getAttribute("data-testid"),
        text: (element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160),
        attributes: Object.fromEntries(
          [...element.attributes]
            .filter(attribute =>
              attribute.name.startsWith("data-") ||
              attribute.name.startsWith("aria-") ||
              [
                "role", "type", "name", "title", "placeholder",
                "disabled", "checked", "selected", "open", "hidden"
              ].includes(attribute.name)
            )
            .map(attribute => [attribute.name, attribute.value])
        ),
        rect: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          left: rect.left
        },
        visible: rect.width > 0 && rect.height > 0 &&
          getComputedStyle(element).visibility !== "hidden",
        computed: computed(element),
        before: computed(element, "::before"),
        after: computed(element, "::after")
      }
    }
    const structuralSignature = (element) => {
      const classes = [...element.classList].sort().join(".")
      const role = element.getAttribute("role") || ""
      const type = element.getAttribute("type") || ""
      const testId = element.getAttribute("data-testid") || ""
      const action = element.getAttribute("data-action") || ""
      return [
        element.tagName.toLowerCase(),
        element.id ? `#${element.id}` : "",
        classes ? `.${classes}` : "",
        role ? `[role=${role}]` : "",
        type ? `[type=${type}]` : "",
        testId ? `[testid=${testId}]` : "",
        action ? `[action=${action}]` : ""
      ].join("")
    }
    const structuralPath = (element) => {
      if (element.id) return `#${CSS.escape(element.id)}`
      const segments = []
      let current = element
      while (current && current !== document.body) {
        let segment = current.tagName.toLowerCase()
        if (current.classList.length) {
          segment += [...current.classList]
            .sort()
            .map(className => `.${CSS.escape(className)}`)
            .join("")
        }
        const parent = current.parentElement
        if (parent) {
          const sameTag = [...parent.children]
            .filter(sibling => sibling.tagName === current.tagName)
          if (sameTag.length > 1) {
            segment += `:nth-of-type(${sameTag.indexOf(current) + 1})`
          }
        }
        segments.unshift(segment)
        current = parent
        if (current?.id) {
          segments.unshift(`#${CSS.escape(current.id)}`)
          break
        }
      }
      return segments.join(" > ")
    }
    const collectStructuralElements = () => {
      const counts = new Map()
      const omitted = {
        excludedSubtree: 0,
        excludedTag: 0,
        invisible: 0,
        repeatLimit: 0,
        maxElements: 0
      }
      const elements = []
      const candidates = [document.body, ...document.body.querySelectorAll("*")]
      for (const element of candidates) {
        if (collectorConfig.excludedTags.includes(element.tagName)) {
          omitted.excludedTag += 1
          continue
        }
        if (collectorConfig.excludedSubtrees.some(selector =>
          element.matches(selector) || element.closest(selector)
        )) {
          omitted.excludedSubtree += 1
          continue
        }
        const rect = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        if (
          rect.width <= 0 ||
          rect.height <= 0 ||
          style.display === "none" ||
          style.visibility === "hidden"
        ) {
          omitted.invisible += 1
          continue
        }
        const signature = structuralSignature(element)
        const count = counts.get(signature) || 0
        if (!element.id && count >= collectorConfig.repeatLimit) {
          omitted.repeatLimit += 1
          continue
        }
        if (elements.length >= collectorConfig.maxElements) {
          omitted.maxElements += 1
          continue
        }
        counts.set(signature, count + 1)
        elements.push(describe(element, elements.length, {
          path: structuralPath(element),
          signature,
          signatureIndex: count
        }))
      }
      return {
        repeatLimit: collectorConfig.repeatLimit,
        maxElements: collectorConfig.maxElements,
        omitted,
        elements
      }
    }
    return {
      schemaVersion: 2,
      url: location.href,
      title: document.title,
      capturedAt: new Date().toISOString(),
      viewport: {
        width: innerWidth,
        height: innerHeight,
        devicePixelRatio,
        scrollX,
        scrollY
      },
      documentState: {
        theme: document.body.dataset.theme || null,
        animated: document.body.getAttribute("animated"),
        activePanel: document.querySelector("#left_panel")
          ?.getAttribute("active_panel") || null
      },
      structuralCoverage: collectStructuralElements(),
      selectors: Object.fromEntries(selectors.map(selector => [
        selector,
        [...document.querySelectorAll(selector)]
          .slice(
            0,
            selector === "story-item" ? 10
              : selector === "story-item .tag" ? 16
                : 6
          )
          .map(describe)
      ]))
    }
  }
  return page.evaluate(collectStyles, structuralCollectorConfig)
}

async function screenshot(page, file) {
  await settleImages(page)
  const styles = await computedStyleSnapshot(page)
  fs.writeFileSync(
    file.replace(/\.png$/, ".styles.json"),
    `${JSON.stringify(styles, null, 2)}\n`
  )
  await page.screenshot({
    path: file,
    animations: "disabled"
  })
}

async function setTheme(page, theme, openSection) {
  await openSection("theme")
  await page.getByTestId("theme").selectOption(theme)
  await expect(page.locator("body")).toHaveAttribute("data-theme", theme)
}

async function replaceVisualSources(page, openSection, sourceLines) {
  await openSection("sources")
  const sources = page.getByTestId("sources")
  await sources.evaluate((textarea, value) => {
    textarea.value = value
    textarea.dispatchEvent(new Event("input", { bubbles: true }))
  }, sourceLines)
  await expect(sources).toHaveValue(sourceLines)
  const save = page.getByTestId("save-sources")
  await save.evaluate(button => button.click())
  await expect(save).toBeEnabled()
}

function visualErrorState(page, openSection, sourceLines, failingSource) {
  return {
    async populate() {
      await replaceVisualSources(
        page,
        openSection,
        `${sourceLines}\n${failingSource}`
      )
      const entries = page.locator("#error_log .error_log_entry")
      await expect(entries).toHaveCount(1, { timeout: 10_000 })
      const entry = entries.last()
      await entry.evaluate((element, sourcePath) => {
        element.open = true
        element.dataset.sourceUrl = sourcePath
        const details = element.querySelector("pre")
        if (details) {
          details.textContent = [
            "7/15/2030, 12:00:00 PM",
            "Error: HTTP 503: Service Unavailable",
            "",
            `Story source: ${sourcePath}`
          ].join("\n")
        }
      }, "/failure.rss")
      await expect(entry).toHaveAttribute("open", "")
    },
    async clear() {
      await page.locator("#clear_error_log").evaluate(button => button.click())
      await expect(page.locator("#error_log .error_log_entry")).toHaveCount(0)
      await expect(page.locator("#error_log .error_log_empty")).toBeVisible()
      await replaceVisualSources(page, openSection, sourceLines)
      await expect(page.locator("#status_bar")).toBeHidden({ timeout: 10_000 })
    }
  }
}

async function captureSettingsMatrix(
  page,
  output,
  prefix,
  openIndex,
  openSection,
  errorState
) {
  await openIndex()
  await screenshot(page, path.join(output, `${prefix}-settings-index.png`))
  for (const section of settingsSections) {
    if (section === "errors") await errorState.populate()
    await openSection(section)
    await expect(
      page.locator(`[data-settings-section="${section}"]`)
    ).toBeVisible()
    await screenshot(
      page,
      path.join(output, `${prefix}-settings-${section}.png`)
    )
    if (section === "errors") await errorState.clear()
  }
}

async function cancelSwipe(story) {
  await story.evaluate(() => {
    document.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true }))
  })
}

async function captureSwipeMatrix(page, story, output, prefix) {
  await story.scrollIntoViewIfNeeded()
  await dragStory(story, -110, { release: false })
  await screenshot(page, path.join(output, `${prefix}-swipe-left-stage1.png`))
  await cancelSwipe(story)

  await dragStory(story, 300, { release: false })
  await screenshot(page, path.join(output, `${prefix}-swipe-right-stage2.png`))
  await cancelSwipe(story)
}

async function captureElectron(output, sourceRoot = repoRoot) {
  const fixture = await startPageServer()
  const urls = storyFixture.storyUrls(fixture.origin)
  let electronApp
  let userData
  let page
  try {
    ;({ electronApp, userData, window: page } = await launchApp({
      appRoot: sourceRoot,
      env: {
        ONCE_ELECTRON_DISABLE_NETWORK_FETCH: "0"
      }
    }))
    await electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.setBounds({ x: 0, y: 0, width: 1280, height: 800 })
    })
    const sourceLines = [
      storyFixture.sourceLine(fixture.origin),
      storyFixture.rssSourceLine(fixture.origin)
    ].join("\n")
    await seedLocalSource(page, sourceLines, urls.alpha)
    await expect(page.getByTestId("story")).toHaveCount(10)
    const electronReadStory = page.locator(
      `story-item[data-href="${urls.beta}"]`
    )
    const electronStarStory = page.locator(
      `story-item[data-href="${urls.gamma}"]`
    )
    const electronSwipeStory = page.locator(
      `story-item[data-href="${urls.epsilon}"]`
    )
    const openIndex = async () => {
      await openPanel(page, "settings")
      const index = page.locator("#settings_sections")
      const back = page.locator("#settings_section_back")
      if (!(await index.isVisible())) {
        await back.evaluate(button => button.click())
      }
      await expect(index).toBeVisible()
    }
    const openSection = section => openSettingsSection(page, section)
    for (const theme of themes) {
      const prefix = `electron-${theme}`
      await setTheme(page, theme, openSection)
      await openPanel(page, "stories")
      await screenshot(page, path.join(output, `${prefix}-stories.png`))
      await electronReadStory.locator(".read_btn").click()
      await expect(electronReadStory).toHaveClass(/\bread\b/)
      await electronStarStory.locator(".star_btn").click()
      await expect(electronStarStory).toHaveClass(/\bstared\b/)
      await screenshot(page, path.join(output, `${prefix}-story-states.png`))
      await electronReadStory.locator(".read_btn").click()
      await electronStarStory.locator(".star_btn").click()
      await captureSwipeMatrix(
        page,
        electronSwipeStory,
        output,
        prefix
      )
      await captureSettingsMatrix(
        page,
        output,
        prefix,
        openIndex,
        openSection,
        visualErrorState(
          page,
          openSection,
          sourceLines,
          `${fixture.origin}/failure.rss`
        )
      )

      const address = page.locator("#urlfield")
      await address.fill(`once-reader://${fixture.origin}/article`)
      await address.press("Enter")
      await expect(page.locator(".electron-tab-title").last()).toHaveText(
        "Regenerated Article",
        { timeout: 15_000 }
      )
      await screenshot(page, path.join(output, `${prefix}-reading.png`))
    }
  } finally {
    if (electronApp && userData) await closeApp(electronApp, userData)
    await fixture.close()
  }
}

async function captureMobile(output, sourceRoot = repoRoot) {
  const server = startTestServer({ appRoot: sourceRoot })
  const started = await server.ready
  const browser = await chromium.launch()
  const context = await browser.newContext({
    ...devices["Pixel 7"],
    baseURL: `http://127.0.0.1:${started.port}/app/`
  })
  const page = await context.newPage()
  try {
    await gotoMobileApp(page)
    await openMobileSettingsSection(page, "theme")
    const animation = page.locator("#anim_checkbox")
    if (await animation.isChecked()) await animation.uncheck()

    const mobileOrigin = new URL(page.url()).origin
    const sourceLines = [
      storyFixture.sourceLine(
        mobileOrigin,
        "/fixtures/visual-feed.json"
      ),
      storyFixture.rssSourceLine(mobileOrigin)
    ].join("\n")
    await openMobileSettingsSection(page, "sources")
    await page.getByTestId("sources").fill(sourceLines)
    await saveSourcesAndWait(page)
    await reloadMobileApp(page)
    await page.getByTestId("stories-menu").click()
    await page.getByTestId("reload-stories").click()
    await expect(page.getByTestId("story")).toHaveCount(10, {
      timeout: 20_000
    })
    const mobileStories = page.getByTestId("story")
    const mobileReadStory = mobileStories.filter({
      hasText: storyFixture.STORY_TITLES.beta
    })
    const mobileStarStory = mobileStories.filter({
      hasText: storyFixture.STORY_TITLES.gamma
    })
    const mobileSwipeStory = mobileStories.filter({
      hasText: storyFixture.STORY_TITLES.epsilon
    })
    const openIndex = async () => {
      await page.getByTestId("settings-menu").click()
      const index = page.locator("#settings_sections")
      const back = page.locator("#settings_section_back")
      if (!(await index.isVisible())) {
        await back.evaluate(button => button.click())
      }
      await expect(index).toBeVisible()
    }
    const openSection = async section => {
      await openIndex()
      await page.locator(`[data-settings-target="${section}"]`).click()
    }
    let readerInitialized = false
    for (const theme of themes) {
      const prefix = `mobile-${theme}`
      await setTheme(page, theme, openSection)
      await page.getByTestId("stories-menu").click()
      await page.evaluate(() => window.scrollTo(0, 0))
      await screenshot(page, path.join(output, `${prefix}-stories.png`))
      await mobileReadStory.getByTestId("story-menu-button").click()
      await page.getByTestId("story-menu-toggle-read").click()
      await expect(mobileReadStory).toHaveClass(/\bread\b/)
      await mobileStarStory.getByTestId("story-menu-button").click()
      await page.getByTestId("story-menu-toggle-bookmark").click()
      await expect(mobileStarStory).toHaveClass(/\bstared\b/)
      await screenshot(page, path.join(output, `${prefix}-story-states.png`))
      await mobileReadStory.getByTestId("story-menu-button").click()
      await page.getByTestId("story-menu-toggle-read").click()
      await mobileStarStory.getByTestId("story-menu-button").click()
      await page.getByTestId("story-menu-toggle-bookmark").click()
      await captureSwipeMatrix(
        page,
        mobileSwipeStory,
        output,
        prefix
      )
      await captureSettingsMatrix(
        page,
        output,
        prefix,
        openIndex,
        openSection,
        visualErrorState(
          page,
          openSection,
          sourceLines,
          `${mobileOrigin}/failure.rss`
        )
      )

      if (!readerInitialized) {
        await page.getByTestId("stories-menu").click()
        await page.getByTestId("story")
          .filter({ hasText: storyFixture.STORY_TITLES.alpha })
          .getByTestId("story-title")
          .click()
      } else {
        await page.getByTestId("reading-menu").click()
      }
      await expect(page.locator("#reading_content")).toHaveAttribute(
        "data-load-state",
        "ready",
        { timeout: 20_000 }
      )
      const readerToggle = page.locator("#reading_reader_toggle")
      if (!(await readerToggle.getAttribute("class") || "").includes("active")) {
        await readerToggle.click()
      }
      await expect(page.locator(".once-reader-host")).toBeVisible({
        timeout: 20_000
      })
      readerInitialized = true
      await screenshot(page, path.join(output, `${prefix}-reading.png`))
    }
  } finally {
    await context.close()
    await browser.close()
    await server.stop()
  }
}

// The report's keyboard layer, kept out of reportHtml so the markup builder
// stays readable. Samples are located by scroll position rather than by a
// stored index, so arrow stepping stays correct after the reader scrolls or
// follows a link by hand.
function reportScript() {
  return `
  const sections = [...document.querySelectorAll("section")]
  const orderStatus = document.querySelector("#comparison-order")
  const sampleStatus = document.querySelector("#sample-status")
  const header = document.querySelector("header")
  const sampleGap = 12
  function setCurrentLeft(currentLeft) {
    document.body.classList.toggle("current-left", currentLeft)
    orderStatus.textContent = currentLeft
      ? "Current left, previous right"
      : "Previous left, current right"
  }
  function headerBottom() {
    return header.getBoundingClientRect().bottom
  }
  function sampleOffset(index) {
    return sections[index].getBoundingClientRect().top -
      headerBottom() - sampleGap
  }
  function nearestSample() {
    let nearest = 0
    sections.forEach((section, index) => {
      if (sampleOffset(index) <= 4) nearest = index
    })
    return nearest
  }
  function markSample(index) {
    sections.forEach((section, position) => {
      section.classList.toggle("active", position === index)
    })
    sampleStatus.textContent =
      "Sample " + (index + 1) + " of " + sections.length + ": " +
      sections[index].dataset.sample
  }
  function showSample(index) {
    const clamped = Math.min(Math.max(index, 0), sections.length - 1)
    scrollTo({ top: scrollY + sampleOffset(clamped) })
    markSample(clamped)
  }
  // From an unaligned scroll position the first press settles on the sample the
  // reader is looking at; only an aligned one steps to a neighbour.
  function stepSample(delta) {
    const nearest = nearestSample()
    const offset = sampleOffset(nearest)
    if (delta > 0 && offset > 4) return showSample(nearest)
    if (delta < 0 && offset < -4) return showSample(nearest)
    showSample(nearest + delta)
  }
  document.addEventListener("keydown", (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
    if (event.key === "ArrowLeft") setCurrentLeft(true)
    else if (event.key === "ArrowRight") setCurrentLeft(false)
    else if (event.key === "ArrowDown") stepSample(1)
    else if (event.key === "ArrowUp") stepSample(-1)
    else return
    event.preventDefault()
  })
  addEventListener("scroll", () => markSample(nearestSample()), {
    passive: true
  })
  markSample(nearestSample())
`
}

function reportHtml({
  baseline,
  baselineHref = "baseline",
  baselineLabel = "Previous run",
  currentLabel = "Current built app",
  imageNames
}) {
  const rows = imageNames
    .map(name => {
      const baselineExists = fs.existsSync(path.join(baseline, name))
      const styles = styleSnapshotName(name)
      const baselineStylesExist = fs.existsSync(path.join(baseline, styles))
      const sample = name.replace(".png", "")
      return `<section data-sample="${sample}">
        <h2>${sample}</h2>
        <div class="comparison">
          <figure class="previous"><figcaption>${baselineExists ? baselineLabel : "No previous run"}</figcaption>
            ${baselineExists ? `<img src="${baselineHref}/${name}" alt="Previous ${name}">` : "<p>Run the command again to compare against this capture.</p>"}
            ${baselineStylesExist ? `<p><a href="${baselineHref}/${styles}">Previous computed styles JSON</a></p>` : ""}
          </figure>
          <figure class="current"><figcaption>${currentLabel}</figcaption>
            <img src="current/${name}" alt="Current ${name}">
            <p><a href="current/${styles}">Current computed styles JSON</a></p>
          </figure>
        </div>
      </section>`
    }).join("\n")
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Once built-app visual review</title>
<style>
  :root { color-scheme: dark; font-family: system-ui, sans-serif; }
  body { margin: 0; padding: 0 24px 24px; background: #202124; color: #f1f3f4; }
  header { position: sticky; top: 0; z-index: 2; padding: 24px 0 12px; background: #202124; box-shadow: 0 1px 0 #5f6368; }
  header p { margin: 0 0 8px; }
  h1, h2 { margin: 0 0 12px; }
  section { margin-bottom: 36px; padding-left: 12px; border-left: 3px solid transparent; }
  section.active { border-left-color: #8ab4f8; }
  section.active h2 { color: #8ab4f8; }
  .comparison { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
  figure { min-width: 0; margin: 0; padding: 12px; border: 1px solid #5f6368; background: #292a2d; }
  body.current-left .comparison .current { order: -1; }
  figcaption { margin-bottom: 8px; font-weight: 600; }
  img { display: block; max-width: 100%; height: auto; background: white; }
  @media (max-width: 900px) { .comparison { grid-template-columns: 1fr; } }
</style></head><body>
<header><h1>Once built-app visual review</h1>
<p>Deterministic fixture data rendered by the packaged Electron app and generated mobile web app.</p>
<p><kbd>←</kbd> Current on left · <kbd>→</kbd> Previous on left · <span id="comparison-order" role="status">Previous left, current right</span></p>
<p><kbd>↑</kbd> <kbd>↓</kbd> Jump between samples · <span id="sample-status" role="status"></span></p></header>
${rows}
<script>${reportScript()}</script>
</body></html>`
}

function printHelp() {
  console.log(`Usage: npm run visual:compare -- [options]

Builds the real app targets, loads deterministic E2E data, and captures stories,
reading, the settings index, and all nine settings panels in light and dark
themes. The previous capture becomes the side-by-side baseline.

  --skip-build      reuse existing Electron and mobile build outputs
  --electron-only   capture only the packaged Electron app
  --mobile-only     capture only the generated mobile web app
  --ref REF         compare with REF and retain its results by commit SHA
  --ref-only        prepare and retain REF without touching the current run
  --output DIR      write artifacts below DIR
`)
}

function prepareHistoricalOutput(output, imageNames) {
  fs.mkdirSync(output, { recursive: true })
  for (const name of imageNames) {
    fs.rmSync(path.join(output, name), { force: true })
    fs.rmSync(path.join(output, styleSnapshotName(name)), { force: true })
  }
}

function writeRunManifest(output, details) {
  fs.writeFileSync(
    path.join(output, "manifest.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      capturedAt: new Date().toISOString(),
      ...details
    }, null, 2)}\n`
  )
}

function configureHistoricalInstallPolicy(worktree) {
  const packagePath = path.join(worktree, "package.json")
  const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"))
  packageJson.allowScripts = {
    ...(packageJson.allowScripts || {}),
    node: true,
    esbuild: true,
    "electron-winstaller": true,
    leveldown: true,
    sharp: true,
    appium: false,
    "appium-ios-tuntap": false,
    edgedriver: false,
    geckodriver: false
  }
  fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`)
}

async function captureTargets(options, output, sourceRoot) {
  if (options.electron) await captureElectron(output, sourceRoot)
  if (options.mobile) await captureMobile(output, sourceRoot)
}

async function captureHistoricalRef(options, imageNames, sha) {
  const runName = historicalRunName(sha)
  const runOutput = path.join(options.output, "runs", runName)
  prepareHistoricalOutput(runOutput, imageNames)
  const tempParent = fs.mkdtempSync(path.join(os.tmpdir(), "once-visual-ref-"))
  const worktree = path.join(tempParent, "worktree")
  let added = false
  try {
    runGit(["worktree", "add", "--detach", worktree, sha], { quiet: true })
    added = true
    configureHistoricalInstallPolicy(worktree)
    runNpm(
      ["ci", "--allow-git=all"],
      worktree,
      {
        ...process.env,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "url.https://github.com/.insteadOf",
        GIT_CONFIG_VALUE_0: "ssh://git@github.com/",
        GIT_TERMINAL_PROMPT: "0"
      }
    )
    if (options.electron) runNpm(["run", "package:electron"], worktree)
    if (options.mobile) {
      runNpm(
        ["run", "mobile", "--", "web", "--channel", "dev", "--e2e"],
        worktree
      )
    }
    await captureTargets(options, runOutput, worktree)
    writeRunManifest(runOutput, {
      ref: options.ref,
      sha,
      targets: [
        ...(options.electron ? ["electron"] : []),
        ...(options.mobile ? ["mobile"] : [])
      ],
      imageNames
    })
    return runOutput
  } finally {
    if (added) {
      runGit(["worktree", "remove", "--force", worktree], { quiet: true })
    }
    fs.rmSync(tempParent, { recursive: true, force: true })
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    printHelp()
    return
  }
  const targets = [
    ...(options.electron ? ["electron"] : []),
    ...(options.mobile ? ["mobile"] : [])
  ]
  const imageNames = buildImageNames(targets)
  if (options.refOnly && !options.ref) {
    throw new Error("--ref-only requires --ref REF")
  }
  let comparisonRoot = null
  let baselineHref = "baseline"
  let baselineLabel = "Previous run"
  if (options.ref) {
    const sha = resolveRef(options.ref)
    const runOutput = path.join(
      options.output,
      "runs",
      historicalRunName(sha)
    )
    if (!options.refOnly && historicalRunComplete(runOutput, imageNames, sha)) {
      comparisonRoot = runOutput
      console.log(`Reusing historical visual run: ${comparisonRoot}`)
    } else {
      comparisonRoot = await captureHistoricalRef(options, imageNames, sha)
    }
    baselineHref = `runs/${historicalRunName(sha)}`
    baselineLabel = `${options.ref} (${sha.slice(0, 12)})`
    if (options.refOnly) {
      console.log(`Historical visual run: ${comparisonRoot}`)
      return
    }
  }
  const directories = prepareOutput(options.output, imageNames)
  if (options.build && options.electron) runNpm(["run", "package:electron"])
  if (options.build && options.mobile) {
    runNpm(["run", "mobile", "--", "web", "--channel", "dev", "--e2e"])
  }
  await captureTargets(options, directories.current, repoRoot)
  comparisonRoot ||= directories.baseline
  fs.writeFileSync(
    path.join(options.output, "index.html"),
    reportHtml({
      baseline: comparisonRoot,
      baselineHref,
      current: directories.current,
      baselineLabel,
      imageNames
    })
  )
  console.log(`Visual comparison: ${path.join(options.output, "index.html")}`)
}

if (require.main === module) {
  main().catch(error => {
    console.error(error)
    process.exitCode = 1
  })
}

module.exports = {
  buildImageNames,
  historicalRunComplete,
  historicalRunName,
  parseArgs,
  reportHtml,
  structuralCollectorConfig,
  styleSnapshotName
}
