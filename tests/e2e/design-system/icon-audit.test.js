const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")
const { chromium } = require("playwright")
const known = require("./known-failures.json")

const iconDirectory = path.resolve(
  __dirname,
  "../../../packages/ui-web/public/static/imgs"
)
const repositoryRoot = path.resolve(__dirname, "../../..")

test("SVG icons stay nonempty, unclipped, bounded, and on the audited grid", {
  timeout: 30_000
}, async () => {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.setContent("<div id='host'></div>")
    const files = fs.readdirSync(iconDirectory)
      .filter((file) => file.endsWith(".svg"))
      .sort()
    const offGrid = []
    const failures = []

    for (const file of files) {
      const source = fs.readFileSync(path.join(iconDirectory, file), "utf8")
      if (Buffer.byteLength(source) > 4096) {
        failures.push(`${file} exceeds 4096 bytes`)
      }
      const measured = await page.evaluate((svgSource) => {
        const host = document.querySelector("#host")
        host.innerHTML = svgSource
        const svg = host.querySelector("svg")
        const viewBox = svg.viewBox.baseVal
        svg.setAttribute("width", String(viewBox.width))
        svg.setAttribute("height", String(viewBox.height))
        svg.style.display = "block"
        const origin = svg.getBoundingClientRect()
        let left = Infinity
        let top = Infinity
        let right = -Infinity
        let bottom = -Infinity
        for (const shape of svg.querySelectorAll(
          "path, circle, ellipse, rect, polygon, polyline, line"
        )) {
          const bounds = shape.getBoundingClientRect()
          if (!bounds.width && !bounds.height) continue
          left = Math.min(left, bounds.left - origin.left)
          top = Math.min(top, bounds.top - origin.top)
          right = Math.max(right, bounds.right - origin.left)
          bottom = Math.max(bottom, bounds.bottom - origin.top)
        }
        return {
          viewBox: [viewBox.x, viewBox.y, viewBox.width, viewBox.height],
          nonempty: Number.isFinite(left) && right > left && bottom > top,
          clipped: left < -0.1 || top < -0.1 ||
            right > viewBox.width + 0.1 || bottom > viewBox.height + 0.1,
          extent: Math.max(
            (right - left) / viewBox.width,
            (bottom - top) / viewBox.height
          )
        }
      }, source)
      if (measured.viewBox.join(" ") !== "0 0 16 16") offGrid.push(file)
      if (!measured.nonempty) failures.push(`${file} has no measurable mark`)
      if (measured.clipped) failures.push(`${file} clips outside its viewBox`)
      if (measured.extent < 0.49) {
        failures.push(`${file} has gross extent ${measured.extent.toFixed(3)}`)
      }
    }

    assert.deepEqual(offGrid, known.iconViewBox.map((entry) => entry.file))
    assert.deepEqual(failures, [])
  } finally {
    await browser.close()
  }
})

test("UI glyph callers use the mask primitive without color filters", () => {
  const sourceFiles = [
    "packages/ui-web/public/shell.html",
    "packages/ui-web/src/story/storyRowMarkup.ts",
    "packages/ui-web/src/presenters/outline.ts",
    "apps/electron/src/browser/browser-shell.html",
    "apps/electron/src/BrowserShell.ts"
  ]
  const uiGlyph = /imgs\/(?!icons\/)[a-z_-]+\.svg/
  for (const relativePath of sourceFiles) {
    const source = fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8")
    assert.doesNotMatch(
      source,
      new RegExp(`<img[^>]+${uiGlyph.source}|(?:src|icon\\.src)\\s*=.*${uiGlyph.source}`),
      `${relativePath} consumes a UI glyph outside the icon primitive`
    )
  }

  const stylesheets = [
    "packages/ui-web/public/static/css/parts/base.css",
    "packages/ui-web/public/static/css/parts/vars.css",
    "packages/ui-web/public/static/css/parts/animations.css",
    "apps/mobile/src/mobile.css"
  ]
  for (const relativePath of stylesheets) {
    const source = fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8")
    assert.doesNotMatch(
      source,
      /(?:\.icon|>\s*img|\.active\s+img)[^{]*\{[^}]*\bfilter\s*:/s,
      `${relativePath} contains an icon color-filter hack`
    )
  }
})
