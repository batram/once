"use strict"

/**
 * Prints the optical-size audit for the icon set: how much of each icon's
 * viewBox its ink actually covers, and how many CSS px of visible mark that
 * leaves inside a 16px box.
 *
 * This is the seed for the icon audit documented in docs/DESIGN_SYSTEM.md.
 *
 *   node docs/tmp-icons/measure-icons.js
 *
 * Measurement note: getBBox() is NOT usable here. It reports an element's own
 * user space and ignores both ancestor transforms and stroke width, so it
 * cannot see a <g transform> wrapper — an earlier version of this script used
 * it, reported the rescaled candidates as unchanged, and put the set median at
 * 97% when it is 88%. Rendering each SVG at exactly its viewBox size makes
 * 1 user unit = 1 CSS px, and getBoundingClientRect() then reports real ink
 * including transforms and stroke.
 */

const fs = require("fs")
const path = require("path")

const REPO = path.resolve(__dirname, "..", "..")
const { chromium } = require(path.join(REPO, "node_modules", "playwright"))
const ICON_DIR = path.join(REPO, "packages", "ui-web", "public", "static", "imgs")
const HERE = __dirname

/** Icons whose ink covers less of the grid than this read visibly small. */
const SMALL_BELOW = 0.84

const sources = fs.readdirSync(ICON_DIR)
  .filter((f) => f.endsWith(".svg"))
  .map((f) => ({
    name: f.replace(/\.svg$/, ""),
    source: fs.readFileSync(path.join(ICON_DIR, f), "utf8")
  }))

// Candidates live alongside this script; include them so before/after is visible.
const candidateStory = path.join(HERE, "story-candidate.svg")
if (fs.existsSync(candidateStory)) {
  sources.push({ name: "story (candidate)", source: fs.readFileSync(candidateStory, "utf8") })
}
const candidateDir = path.join(HERE, "candidates")
if (fs.existsSync(candidateDir)) {
  for (const file of fs.readdirSync(candidateDir).filter((f) => f.endsWith(".svg"))) {
    sources.push({
      name: file.replace(/\.svg$/, "") + " (rescaled)",
      source: fs.readFileSync(path.join(candidateDir, file), "utf8")
    })
  }
}

;(async () => {
  const browser = await chromium.launch()
  const page = await browser.newPage()
  await page.setContent("<div id='host'></div>")

  const rows = []
  for (const { name, source } of sources) {
    const measured = await page.evaluate(({ source }) => {
      const host = document.getElementById("host")
      host.innerHTML = source
      const svg = host.querySelector("svg")
      const vb = svg.viewBox.baseVal
      svg.setAttribute("width", String(vb.width))
      svg.setAttribute("height", String(vb.height))
      svg.style.display = "block"
      const origin = svg.getBoundingClientRect()
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
      for (const el of svg.querySelectorAll("path, circle, rect, polygon, line")) {
        const b = el.getBoundingClientRect()
        if (!b.width && !b.height) continue
        x0 = Math.min(x0, b.left - origin.left); y0 = Math.min(y0, b.top - origin.top)
        x1 = Math.max(x1, b.right - origin.left); y1 = Math.max(y1, b.bottom - origin.top)
      }
      const root = (source.match(/<svg[^>]*>/) || [""])[0]
      return {
        vb: vb.width + "x" + vb.height,
        onGrid: vb.width === 16 && vb.height === 16,
        mode: /stroke="currentColor"/.test(root)
          ? "stroke"
          : /stroke="currentColor"/.test(source) ? "fill+stroke" : "fill",
        inkW: x1 - x0,
        inkH: y1 - y0,
        fill: Math.max((x1 - x0) / vb.width, (y1 - y0) / vb.height)
      }
    }, { source })
    rows.push({ name, ...measured })
  }

  await browser.close()

  const isCandidate = (r) => r.name.includes("(")
  rows.sort((a, b) => a.fill - b.fill)
  const shipped = rows.filter((r) => !isCandidate(r))

  /**
   * The set is bimodal, so a single median misdescribes it — quote the spread.
   * An earlier version reported `sorted[floor(n/2)]`, which lands on whichever
   * mode happens to be larger and reads as if the set were centred there.
   */
  const sorted = shipped.map((r) => r.fill).sort((a, b) => a - b)
  const quantile = (p) => {
    const i = (sorted.length - 1) * p
    const lo = Math.floor(i), hi = Math.ceil(i)
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo)
  }
  const pct = (v) => (v * 100).toFixed(1) + "%"

  const pad = (s, n) => String(s).padEnd(n)
  const num = (v, n, d = 1) => v.toFixed(d).padStart(n)

  console.log(pad("icon", 22) + pad("viewBox", 9) + pad("mode", 13) + "  ink(units)     fill%  mark@16px")
  console.log("-".repeat(84))
  for (const r of rows) {
    const flag = isCandidate(r) ? ""
      : !r.onGrid ? "  <- off grid"
      : r.fill < SMALL_BELOW ? "  <- reads small" : ""
    console.log(
      pad(r.name, 22) + pad(r.vb, 9) + pad(r.mode, 13) +
      num(r.inkW, 6, 2) + " x" + num(r.inkH, 6, 2) +
      num(r.fill * 100, 8) + "%" + num(r.fill * 16, 9, 1) + "px" + flag)
  }
  console.log("-".repeat(84))
  console.log("shipped icons:  " + shipped.length)
  console.log("fill spread:    min " + pct(sorted[0]) +
    " · p25 " + pct(quantile(0.25)) +
    " · median " + pct(quantile(0.5)) +
    " · max " + pct(sorted[sorted.length - 1]))

  // Report the modes explicitly: a spread-around-median rule is meaningless if
  // the set clusters at two ends, and the useful constraint is a floor.
  const full = shipped.filter((r) => r.fill >= 0.99).length
  const rest = shipped.length - full
  console.log("shape:          " + full + " icons at ~100%, " + rest + " below — " +
    (full > 2 && rest > 2 ? "bimodal, use a floor not a spread" : "single cluster"))

  const small = shipped.filter((r) => r.fill < SMALL_BELOW)
  console.log("below " + (SMALL_BELOW * 100).toFixed(0) + "%:      " +
    (small.map((r) => r.name + " (" + (r.fill * 100).toFixed(0) + "%)").join(", ") || "none"))
  const off = shipped.filter((r) => !r.onGrid)
  console.log("off 16 grid:    " + (off.map((r) => r.name + " (" + r.vb + ")").join(", ") || "none"))
})()
