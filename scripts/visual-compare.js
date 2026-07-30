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
  return page.evaluate(() => {
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
      "pointer-events", "touch-action", "object-fit", "aspect-ratio"
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
    const describe = (element, index) => {
      const rect = element.getBoundingClientRect()
      return {
        index,
        tag: element.tagName.toLowerCase(),
        id: element.id || null,
        classes: [...element.classList],
        testId: element.getAttribute("data-testid"),
        text: (element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160),
        attributes: Object.fromEntries(
          [...element.attributes]
            .filter(attribute =>
              attribute.name.startsWith("data-") ||
              ["aria-expanded", "aria-selected", "hidden"].includes(attribute.name)
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
    return {
      schemaVersion: 1,
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
  })
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

async function captureSettingsMatrix(page, output, prefix, openIndex, openSection) {
  await openIndex()
  await screenshot(page, path.join(output, `${prefix}-settings-index.png`))
  for (const section of settingsSections) {
    await openSection(section)
    await expect(
      page.locator(`[data-settings-section="${section}"]`)
    ).toBeVisible()
    await screenshot(
      page,
      path.join(output, `${prefix}-settings-${section}.png`)
    )
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
    await seedLocalSource(
      page,
      [
        storyFixture.sourceLine(fixture.origin),
        storyFixture.rssSourceLine(fixture.origin)
      ].join("\n"),
      urls.alpha
    )
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
        openSection
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

    await openMobileSettingsSection(page, "sources")
    await page.getByTestId("sources").fill(
      [
        storyFixture.sourceLine(
          new URL(page.url()).origin,
          "/fixtures/visual-feed.json"
        ),
        storyFixture.rssSourceLine(new URL(page.url()).origin)
      ].join("\n")
    )
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
        openSection
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
      return `<section>
        <h2>${name.replace(".png", "")}</h2>
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
  body { margin: 0; padding: 24px; background: #202124; color: #f1f3f4; }
  header { position: sticky; top: 0; z-index: 2; padding: 12px 0; background: #202124; }
  h1, h2 { margin: 0 0 12px; }
  section { margin-bottom: 36px; }
  .comparison { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
  figure { min-width: 0; margin: 0; padding: 12px; border: 1px solid #5f6368; background: #292a2d; }
  body.current-left .comparison .current { order: -1; }
  figcaption { margin-bottom: 8px; font-weight: 600; }
  img { display: block; max-width: 100%; height: auto; background: white; }
  @media (max-width: 900px) { .comparison { grid-template-columns: 1fr; } }
</style></head><body>
<header><h1>Once built-app visual review</h1>
<p>Deterministic fixture data rendered by the packaged Electron app and generated mobile web app.</p></header>
<p><kbd>←</kbd> Current on left · <kbd>→</kbd> Previous on left · <span id="comparison-order" role="status">Previous left, current right</span></p>
${rows}
<script>
  const orderStatus = document.querySelector("#comparison-order")
  function setCurrentLeft(currentLeft) {
    document.body.classList.toggle("current-left", currentLeft)
    orderStatus.textContent = currentLeft
      ? "Current left, previous right"
      : "Previous left, current right"
  }
  document.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft") {
      setCurrentLeft(true)
      event.preventDefault()
    } else if (event.key === "ArrowRight") {
      setCurrentLeft(false)
      event.preventDefault()
    }
  })
</script>
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
  styleSnapshotName
}
