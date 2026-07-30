"use strict"

/**
 * Measures every icon's real ink extent with the browser's getBBox(), generates
 * rescaled candidates for the optical-size outliers, and builds a self-contained
 * before/after page. Nothing in the repo is written to.
 */

const fs = require("fs")
const path = require("path")

const REPO = path.resolve(__dirname, "..", "..")
const { chromium } = require(path.join(REPO, "node_modules", "playwright"))
const ICON_DIR = path.join(REPO, "packages", "ui-web", "public", "static", "imgs")
const HERE = __dirname
const OUT = path.join(HERE, "icon-comparison.html")
const CANDIDATE_DIR = path.join(HERE, "candidates")

/** Ink fill below this reads visibly smaller than the set and gets rescaled. */
const TARGET_FILL = 0.86
const RESCALE_BELOW = 0.84

function dataUri(svg) {
  return "data:image/svg+xml," + encodeURIComponent(svg)
}

const icons = {}
for (const file of fs.readdirSync(ICON_DIR)) {
  if (!file.endsWith(".svg")) continue
  const name = file.replace(/\.svg$/, "")
  const source = fs.readFileSync(path.join(ICON_DIR, file), "utf8")
  const root = (source.match(/<svg[^>]*>/) || [""])[0]
  const mode = /stroke="currentColor"/.test(root)
    ? "stroke"
    : /stroke="currentColor"/.test(source) ? "fill+stroke" : "fill"
  icons[name] = {
    name, source, mode,
    viewBox: (source.match(/viewBox="([^"]*)"/) || [])[1] || "?"
  }
}

const candidateStory = fs.readFileSync(path.join(HERE, "story-candidate.svg"), "utf8")

/** Wrap an icon's children in a transform that scales its ink about the centre. */
function rescale(source, measurement, target) {
  const { vbW, vbH, cx, cy, fill } = measurement
  const s = target / fill
  const tx = vbW / 2 - s * cx
  const ty = vbH / 2 - s * cy
  const open = (source.match(/<svg[^>]*>/) || [""])[0]
  const inner = source.slice(source.indexOf(">", source.indexOf("<svg")) + 1).replace(/<\/svg>\s*$/, "")
  const f = (n) => Number(n.toFixed(4))
  return `${open}\n  <g transform="translate(${f(tx)} ${f(ty)}) scale(${f(s)})">${inner}  </g>\n</svg>\n`
}

;(async () => {
  const browser = await chromium.launch()
  const page = await browser.newPage()
  await page.setContent("<div id='host'></div>")

  /**
   * getBBox() reports an element's own user space and ignores both ancestor
   * transforms and stroke width, so it cannot see a <g transform> wrapper.
   * Rendering the SVG at exactly its viewBox size makes 1 user unit = 1 CSS px,
   * and getBoundingClientRect() then reports real ink including transforms and
   * stroke.
   */
  const measure = async (source) => page.evaluate(({ source }) => {
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
      const r = el.getBoundingClientRect()
      if (!r.width && !r.height) continue
      x0 = Math.min(x0, r.left - origin.left); y0 = Math.min(y0, r.top - origin.top)
      x1 = Math.max(x1, r.right - origin.left); y1 = Math.max(y1, r.bottom - origin.top)
    }
    return {
      vbW: vb.width, vbH: vb.height,
      cx: (x0 + x1) / 2, cy: (y0 + y1) / 2,
      fill: Math.max((x1 - x0) / vb.width, (y1 - y0) / vb.height)
    }
  }, { source })

  for (const icon of Object.values(icons)) {
    icon.m = await measure(icon.source)
    icon.fill = icon.m.fill
  }

  // Rescaled candidates for the icons that read small against the set.
  fs.mkdirSync(CANDIDATE_DIR, { recursive: true })
  const rescaled = []
  for (const icon of Object.values(icons)) {
    if (icon.fill >= RESCALE_BELOW) continue
    const source = rescale(icon.source, icon.m, TARGET_FILL)
    const m = await measure(source)
    fs.writeFileSync(path.join(CANDIDATE_DIR, icon.name + ".svg"), source, "utf8")
    rescaled.push({ name: icon.name, source, uri: dataUri(source), before: icon.fill, after: m.fill })
    icon.rescaledUri = dataUri(source)
  }

  const storyM = await measure(candidateStory)
  await browser.close()

  for (const icon of Object.values(icons)) icon.uri = dataUri(icon.source)
  const storyCandidate = { uri: dataUri(candidateStory), fill: storyM.fill }

  // ---- page assembly -------------------------------------------------------

  const vars = Object.values(icons)
    .map((i) => `    --i-${i.name}: url("${i.uri}");`)
    .concat(rescaled.map((r) => `    --i-${r.name}-fixed: url("${r.uri}");`))
    .concat([`    --i-story-candidate: url("${storyCandidate.uri}");`])
    .join("\n")

  const img = (n) => `<img src="${icons[n].uri}" alt="" />`
  const ico = (n, cls) => `<span class="icon ${cls || ""}" style="--icon: var(--i-${n})"></span>`

  // The set is bimodal (a block at ~100%, a block well below), so a single
  // median misdescribes it. Quote the floor and the spread instead.
  const fills = Object.values(icons).map((i) => i.fill).sort((a, b) => a - b)
  const quantile = (p) => {
    const i = (fills.length - 1) * p
    const lo = Math.floor(i), hi = Math.ceil(i)
    return fills[lo] + (fills[hi] - fills[lo]) * (i - lo)
  }
  const p25Pct = (quantile(0.25) * 100).toFixed(0)
  const fullCount = fills.filter((f) => f >= 0.99).length
  const restCount = fills.length - fullCount
  const outliers = Object.values(icons)
    .filter((i) => i.fill < RESCALE_BELOW).sort((a, b) => a.fill - b.fill)
  const outlierNames = outliers.map((i) => `<b>${i.name}</b>`).join(", ")
  const xPct = (icons["x"].fill * 100).toFixed(0)
  const xMark = (icons["x"].fill * 16).toFixed(0)

  const auditRows = Object.values(icons)
    .concat([{ name: "story (candidate)", fill: storyCandidate.fill, viewBox: "0 0 16 16", uri: storyCandidate.uri, isCandidate: true }])
    .sort((a, b) => a.fill - b.fill)
    .map((i) => {
      const pct = i.fill * 100
      const small = i.fill < RESCALE_BELOW && !i.isCandidate
      return `<tr class="${small ? "small" : ""}${i.isCandidate ? " cand" : ""}">
        <td class="ic"><span class="icon" style="--icon: url('${i.uri}'); --icon-size: 16px"></span></td>
        <td class="nm">${i.name}</td>
        <td class="bar"><span style="width:${pct.toFixed(1)}%"></span></td>
        <td class="pc">${pct.toFixed(0)}%</td>
        <td class="mk">${(i.fill * 16).toFixed(1)}px</td>
      </tr>`
    }).join("\n")

  const rescaleCells = rescaled.map((r) => `
    <div class="rs">
      <div class="rs-pair">
        <div><span class="icon" style="--icon: var(--i-${r.name}); --icon-size: 56px"></span>
          <small>now · ${(r.before * 100).toFixed(0)}%</small></div>
        <div><span class="icon" style="--icon: var(--i-${r.name}-fixed); --icon-size: 56px"></span>
          <small>rescaled · ${(r.after * 100).toFixed(0)}%</small></div>
      </div>
      <div class="rs-bar">
        <div class="bar-strip">${["now", "fixed"].map((k) => `
          <span class="btn-next chrome">${k === "now"
            ? `<span class="icon" style="--icon: var(--i-${r.name})"></span>`
            : `<span class="icon" style="--icon: var(--i-${r.name}-fixed)"></span>`}</span>`).join("")}
          <span class="btn-next chrome"><span class="icon" style="--icon: var(--i-star)"></span></span>
          <span class="btn-next chrome"><span class="icon" style="--icon: var(--i-gear)"></span></span>
        </div>
        <small>at real size, beside two 100% icons</small>
      </div>
      <div class="rs-name">${r.name}</div>
    </div>`).join("\n")

  const gridCells = Object.values(icons).map((i) => {
    const off = i.viewBox !== "0 0 16 16"
    return `<figure class="cell${off ? " flag" : ""}">
      <span class="icon" style="--icon: var(--i-${i.name}); --icon-size: 24px"></span>
      <figcaption>${i.name}<em>${i.viewBox} · ${i.mode}</em></figcaption>
    </figure>`
  }).join("\n")

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Once — icon rendering comparison (v2)</title>
<style>
:root {
  color-scheme: light dark;
${vars}
  --main-bg-color: light-dark(rgb(246, 246, 239), #282a36);
  --second-bg-color: light-dark(#ccc, #383a59);
  --border-color: light-dark(#b3b3b3, #282a36);
  --border-high-color: light-dark(#b3b3b3, #373f6e);
  --btn-bg-color: light-dark(#383a5900, #383a59);
  --input-bg-color: light-dark(white, #383a59);
  --text-high-color: light-dark(black, #bcc2cd);
  --text-muted-color: light-dark(#6b6357, #9297a3);
  --ok: light-dark(#1a7f37, #4ac26b);
  --bad: light-dark(#c83d3d, #ff6b6b);
  --warn: light-dark(#9a6200, #e2a642);
}
:root[data-theme="light"] { color-scheme: light; }
:root[data-theme="dark"]  { color-scheme: dark; }
* { box-sizing: border-box; }
body {
  margin: 0; padding: 24px;
  background: light-dark(#fbfbf7, #1e2029);
  color: var(--text-high-color);
  font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
h1 { font-size: 19px; margin: 0 0 4px; }
h2 { font-size: 15px; margin: 0 0 2px; }
.lede { color: var(--text-muted-color); margin: 0 0 20px; max-width: 74ch; }
section {
  margin: 0 0 18px; padding: 16px 18px;
  border: 1px solid var(--border-high-color); border-radius: 8px;
  background: var(--main-bg-color);
}
p.note { color: var(--text-muted-color); margin: 2px 0 14px; max-width: 76ch; font-size: 13px; }
.pair { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 14px; }
.panel {
  border: 1px solid var(--border-color); border-radius: 6px; padding: 12px;
  background: var(--input-bg-color); min-width: 0;
}
.panel > h3 {
  margin: 0 0 10px; font-size: 11px; letter-spacing: .06em; text-transform: uppercase;
  color: var(--text-muted-color); font-weight: 600;
}
.panel.now { --tag: var(--bad); } .panel.next { --tag: var(--ok); } .panel.bugged { --tag: var(--warn); }
.panel > h3::before {
  content: ""; display: inline-block; width: 7px; height: 7px; border-radius: 50%;
  background: var(--tag, var(--text-muted-color)); margin-right: 6px; vertical-align: .5px;
}
.verdict { margin: 10px 0 0; font-size: 12px; color: var(--text-muted-color); }
.verdict b { color: var(--text-high-color); font-weight: 600; }
code { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: .92em;
  background: light-dark(#00000010, #ffffff14); padding: 1px 4px; border-radius: 3px; }

/* ---- the app's current rules, verbatim ---- */
.bar { border-bottom: thin solid var(--border-high-color); padding: 5px 15px;
  display: flex; flex-direction: row; background: var(--main-bg-color); }
.btn { border: thin solid black; cursor: pointer; padding: 2px; font-size: 13px;
  margin: 2px; border-radius: 2px; background: var(--btn-bg-color); user-select: none; }
.bar_btn { padding: 3px; margin: 0; margin-left: 3px; }
.bar_btn img { margin: 2px; margin-bottom: -1px; }
:root[data-theme="dark"] .hack-theme img { filter: contrast(0%); }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .hack-theme img { filter: contrast(0%); }
}
.hack-active img { filter: invert(42%) sepia(93%) saturate(252%) hue-rotate(87deg) brightness(119%) contrast(119%); }

/* ---- proposed primitive ---- */
.icon {
  display: inline-block;
  inline-size: var(--icon-size, 1em); block-size: var(--icon-size, 1em);
  background: currentColor;
  -webkit-mask: var(--icon) center / contain no-repeat;
  mask: var(--icon) center / contain no-repeat;
  vertical-align: -0.125em; flex: none;
}
/* chrome buttons: fixed 16px box, centred by the container */
.btn-next {
  display: inline-flex; align-items: center; justify-content: center; gap: 4px;
  --icon-size: 16px;
  border: thin solid var(--border-high-color); border-radius: 2px;
  padding: 3px; margin-left: 3px;
  font: inherit; font-size: 13px; background: var(--btn-bg-color); color: inherit; cursor: pointer;
}
.btn-next .icon { vertical-align: 0; }
.btn-next.chrome { padding: 5px; }
/* the naive version — what v1 of this page showed */
.btn-naive { border: thin solid black; padding: 3px; font-size: 13px; margin-left: 3px;
  border-radius: 2px; background: var(--btn-bg-color); }
.btn-naive .icon { margin: 2px; }
.accent { color: light-dark(#1a7f37, #4ac26b); }

.scale-row { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; margin-bottom: 8px; }
.scale-row > span:first-child { color: var(--text-muted-color); font-size: 11px; width: 72px; flex: none; }
.s13 { font-size: 13px; } .s16 { font-size: 16px; } .s22 { font-size: 22px; }
.inline-demo { font-size: 15px; line-height: 1.7; }

.rule { position: relative; display: inline-block; }
.rule::after { content: ""; position: absolute; left: -8px; right: -8px; bottom: 0;
  border-bottom: 1px dashed light-dark(#d02f2f, #ff8a8a); }
.zoomwrap { height: 84px; display: flex; align-items: center; overflow: hidden; }
.zoom { transform: scale(3.2); transform-origin: left center; }

/* ---- audit table ---- */
table.audit { width: 100%; border-collapse: collapse; font-size: 12px; }
table.audit td { padding: 3px 6px; border-bottom: 1px solid light-dark(#00000010, #ffffff10); }
table.audit td.ic { width: 26px; }
table.audit td.nm { width: 130px; color: var(--text-muted-color); }
table.audit td.bar { }
table.audit td.bar span { display: block; height: 9px; border-radius: 2px;
  background: light-dark(#7d8ba1, #6c7a99); }
table.audit tr.small td.bar span { background: var(--bad); }
table.audit tr.small td.nm { color: var(--text-high-color); font-weight: 600; }
table.audit tr.cand td.bar span { background: light-dark(#1a63d0, #6ea8ff); }
table.audit tr.cand td.nm { font-style: italic; }
table.audit td.pc, table.audit td.mk { width: 52px; text-align: right;
  font-variant-numeric: tabular-nums; color: var(--text-muted-color); }

/* ---- rescale gallery ---- */
.rs-wrap { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 14px; }
.rs { border: 1px solid var(--border-color); border-radius: 6px; padding: 12px;
  background: var(--input-bg-color); text-align: center; }
.rs-pair { display: flex; justify-content: center; gap: 20px; }
.rs-pair > div { display: flex; flex-direction: column; align-items: center; gap: 6px; }
.rs small { color: var(--text-muted-color); font-size: 10px; }
.rs-bar { margin-top: 12px; }
.bar-strip { display: flex; justify-content: center; align-items: center;
  padding: 5px; background: var(--main-bg-color);
  border: 1px solid var(--border-color); border-radius: 4px; }
.rs-name { margin-top: 10px; font-size: 12px; font-weight: 600; }

.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 10px; }
.cell { margin: 0; padding: 12px 6px 8px; text-align: center;
  border: 1px solid var(--border-color); border-radius: 6px; background: var(--input-bg-color); }
.cell.flag { border-color: var(--bad); border-width: 2px; }
.cell figcaption { font-size: 10px; color: var(--text-muted-color); margin-top: 8px;
  line-height: 1.35; word-break: break-word; }
.cell figcaption em { display: block; font-style: normal; opacity: .75; font-size: 9px; }

.side-by-side { display: flex; gap: 26px; align-items: flex-end; flex-wrap: wrap; }
.spec { text-align: center; } .spec > div { margin-bottom: 6px; }
.spec small { color: var(--text-muted-color); font-size: 10px; display: block; }
.overlay-box { position: relative; width: 90px; height: 90px; }
.overlay-box .icon { position: absolute; inset: 0; --icon-size: 90px; }
.overlay-box .a { color: light-dark(#d02f2f, #ff6b6b); opacity: .85; }
.overlay-box .b { color: light-dark(#1a63d0, #6ea8ff); opacity: .7; }
.menu_sub { border-top: thin solid var(--border-high-color); font-size: 13px; }
.menu_heading { display: flex; align-items: center; gap: 3px; padding: 5px; }
.menu_heading p { margin: 0; }

.toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 20px; flex-wrap: wrap; }
.toolbar button { font: inherit; font-size: 12px; padding: 5px 11px; cursor: pointer;
  border: 1px solid var(--border-high-color); border-radius: 5px;
  background: var(--input-bg-color); color: inherit; }
.toolbar button[aria-pressed="true"] { background: var(--second-bg-color); font-weight: 600; }
.fixnote { border-left: 3px solid var(--warn); padding: 8px 12px; margin: 0 0 14px;
  background: light-dark(#9a620012, #e2a64216); border-radius: 0 4px 4px 0; font-size: 13px; }
</style>
</head>
<body>

<h1>Icon rendering — current vs proposed <span style="font-weight:400;color:var(--text-muted-color);font-size:14px">(v2)</span></h1>
<p class="lede">
  Built from the 20 real SVGs in <code>packages/ui-web/public/static/imgs/</code>. Red panels reproduce the
  app's current CSS verbatim; green panels use the proposed primitive. Ink extents measured with the
  browser's own <code>getBBox()</code>.
</p>

<div class="fixnote">
  <b>Fixed since v1</b>, both from your read of it: proposed icons now use a fixed
  <code>--icon-size: 16px</code> (v1 inherited <code>1em</code> = the button's 13px, so everything rendered
  19% smaller than the <code>&lt;img&gt;</code> baseline), and icon-only buttons are now
  <code>inline-flex</code> + <code>align-items: center</code> (v1 left them baseline-aligned, which is why
  they rode high). Section 4 shows that bug deliberately.
</div>

<div class="toolbar">
  <span style="font-size:12px;color:var(--text-muted-color)">Theme:</span>
  <button data-theme-set="light" aria-pressed="false">Light</button>
  <button data-theme-set="dark" aria-pressed="false">Dark</button>
  <button data-theme-set="system" aria-pressed="true">System</button>
</div>

<section>
  <h2>1. Colour inheritance</h2>
  <p class="note">
    An SVG loaded through <code>&lt;img&gt;</code> is an isolated document, so its
    <code>fill="currentColor"</code> resolves against its own initial colour — black — in both themes.
    The mask paints <code>background: currentColor</code>, so it inherits. Both rows are 16px boxes.
  </p>
  <div class="pair">
    <div class="panel now">
      <h3>Now — &lt;img src&gt;</h3>
      <div class="bar">
        <div class="btn bar_btn">${img("chevron-left")}</div>
        <div class="btn bar_btn">${img("reload")}</div>
        <div class="btn bar_btn">${img("x")}</div>
        <div class="btn bar_btn">${img("filter")}</div>
        <div class="btn bar_btn">${img("star")}</div>
      </div>
      <p class="verdict">In dark mode these stay <b>black on dark</b>.</p>
    </div>
    <div class="panel next">
      <h3>Proposed — mask + currentColor</h3>
      <div class="bar">
        <button class="btn-next">${ico("chevron-left")}</button>
        <button class="btn-next">${ico("reload")}</button>
        <button class="btn-next">${ico("x")}</button>
        <button class="btn-next">${ico("filter")}</button>
        <button class="btn-next">${ico("star")}</button>
      </div>
      <p class="verdict">Follows text colour; tintable per state — <span class="accent">${ico("star_fill")} accent</span>.</p>
    </div>
  </div>
</section>

<section>
  <h2>2. What the filter hacks actually produce</h2>
  <p class="note">
    <code>filter: contrast(0%)</code> for dark mode (vars.css:67) and a five-stage
    <code>invert/sepia/saturate/hue-rotate/brightness</code> chain for the active state (base.css:75).
  </p>
  <div class="pair">
    <div class="panel now">
      <h3>Now — contrast(0%) in dark</h3>
      <div class="bar hack-theme">
        <div class="btn bar_btn">${img("gear")}</div>
        <div class="btn bar_btn">${img("reading")}</div>
        <div class="btn bar_btn">${img("story")}</div>
      </div>
      <p class="verdict">Flattens to <b>mid-grey</b>, not <code>--text-high-color</code>.</p>
    </div>
    <div class="panel next">
      <h3>Proposed — the token itself</h3>
      <div class="bar">
        <button class="btn-next">${ico("gear")}</button>
        <button class="btn-next">${ico("reading")}</button>
        <button class="btn-next">${ico("story")}</button>
      </div>
      <p class="verdict">Exactly <code>--text-high-color</code> in both themes. Both filter rules deleted.</p>
    </div>
  </div>
  <div class="pair" style="margin-top:14px">
    <div class="panel now">
      <h3>Now — .active invert chain</h3>
      <div class="bar hack-active">
        <div class="btn bar_btn">${img("star_fill")}</div>
        <div class="btn bar_btn">${img("read")}</div>
      </div>
      <p class="verdict">A green that exists in no token.</p>
    </div>
    <div class="panel next">
      <h3>Proposed — colour it</h3>
      <div class="bar">
        <button class="btn-next accent">${ico("star_fill")}</button>
        <button class="btn-next accent">${ico("read")}</button>
      </div>
      <p class="verdict">One <code>color:</code> declaration, theme-aware.</p>
    </div>
  </div>
</section>

<section>
  <h2>3. Size — two modes, deliberately</h2>
  <p class="note">
    <b>Chrome buttons take a fixed box</b> (<code>--icon-size: 16px</code>) so they match today's rendering
    exactly and don't shrink with the 13px button font. <b>Icons inline with running text take
    <code>1em</code></b>, which is the case where scaling with the text is what you want — and the case where
    <code>&lt;img&gt;</code> can never work, since its em resolves against the SVG's own 16px default.
  </p>
  <div class="pair">
    <div class="panel now">
      <h3>Now — always 16px, everywhere</h3>
      <div class="scale-row s13"><span>13px text</span><span class="btn">${img("gear")} Settings</span></div>
      <div class="scale-row s22"><span>22px text</span><span class="btn">${img("gear")} Settings</span></div>
      <p class="verdict inline-demo" style="margin-top:14px">
        Inline: press ${img("star")} to save, or ${img("x")} to dismiss.
      </p>
      <p class="verdict">Icon can't track the text; a fixed 16px next to 22px type reads undersized.</p>
    </div>
    <div class="panel next">
      <h3>Proposed — fixed in chrome, 1em inline</h3>
      <div class="scale-row s13"><span>13px text</span><button class="btn-next">${ico("gear")} Settings</button></div>
      <div class="scale-row s22"><span>22px text</span><button class="btn-next">${ico("gear")} Settings</button></div>
      <p class="verdict inline-demo" style="margin-top:14px">
        Inline: press <span class="icon" style="--icon: var(--i-star)"></span> to save,
        or <span class="icon" style="--icon: var(--i-x)"></span> to dismiss.
      </p>
      <p class="verdict">Chrome pinned to 16px; inline icons scale with the sentence.</p>
    </div>
  </div>
</section>

<section>
  <h2>4. Vertical alignment — including the bug you spotted</h2>
  <p class="note">
    In an inline formatting context the strut reserves descender space below the baseline, so an
    icon-only button leaves ~1px of dead space underneath and the glyph rides high. That is exactly what
    <code>.bar_btn img { margin-bottom: -1px }</code> cancels — and what v1 of this page removed without
    replacing. The fix is not a different nudge; it is to stop using baseline alignment for a box that
    should be centred. Shown at 3.2×, text baseline dashed.
  </p>
  <div class="pair">
    <div class="panel now">
      <h3>Now — margin-bottom: -1px</h3>
      <div class="zoomwrap"><span class="zoom"><span class="rule bar_btn">${img("star")}</span></span></div>
      <p class="verdict">Correct at exactly one font-size.</p>
    </div>
    <div class="panel bugged">
      <h3>v1's mistake — nudge removed, still inline</h3>
      <div class="zoomwrap"><span class="zoom"><span class="rule btn-naive">${ico("star")}</span></span></div>
      <p class="verdict">Rides high: the descender gap is still there with nothing cancelling it.</p>
    </div>
    <div class="panel next">
      <h3>Proposed — inline-flex, centred</h3>
      <div class="zoomwrap"><span class="zoom"><span class="rule"><span class="btn-next">${ico("star")}</span></span></span></div>
      <p class="verdict">Centred by the container. No nudge exists, so none can drift.</p>
    </div>
  </div>
</section>

<section>
  <h2>5. Optical size audit — the real reason x reads small</h2>
  <p class="note">
    Ink extent as a share of the viewBox, measured per icon with
    <code>getBoundingClientRect()</code> so transforms and stroke are included. The set is
    <b>bimodal</b>: ${fullCount} icons fill their grid completely, ${restCount} sit below, and nothing
    lands in between — so there is no meaningful "average" icon size to design against.
    <code>x</code> covers only <b>${xPct}%</b>, giving a visible mark of ${xMark}px inside a 16px box,
    around half its neighbours. This is pre-existing and independent of the mask change; it is why the
    same CSS produces visibly different icon sizes, and why "make the icons line up" feels unlearnable.
  </p>
  <table class="audit">${auditRows}</table>
  <p class="verdict" style="margin-top:12px">
    ${outliers.length} icons sit below ${(RESCALE_BELOW * 100).toFixed(0)}%: ${outlierNames}.
    Bootstrap draws these small on purpose (its own close button renders <code>bi-x</code> much larger),
    so inheriting them at 16px is the mismatch.
  </p>
</section>

<section>
  <h2>6. Rescaled candidates for the five outliers</h2>
  <p class="note">
    Generated by wrapping each icon's existing paths in a <code>&lt;g transform&gt;</code> that scales the ink
    about its centre to ${(TARGET_FILL * 100).toFixed(0)}% fill — no path is redrawn, so the glyphs are
    unchanged and the edit is one line per file. ${(TARGET_FILL * 100).toFixed(0)}% sits just above the
    set's lower cluster (p25 is ${p25Pct}%) rather than at the 100% mode, because a sparse mark at full
    extent reads heavier than a dense one; adjust
    <code>TARGET_FILL</code> to taste.
  </p>
  <div class="rs-wrap">${rescaleCells}</div>
</section>

<section>
  <h2>7. story.svg — the one off-grid icon</h2>
  <p class="note">
    The sole <code>0 0 20 20</code> icon, drawn with <code>stroke-width="2"</code> — ~1.6px of effective
    weight at display size against the set's ~1px. Candidate keeps the motif on the 16 grid at
    <code>stroke-width="1.5"</code>.
  </p>
  <div class="side-by-side">
    <div class="spec">
      <div class="overlay-box">
        <span class="icon a" style="--icon: var(--i-story)"></span>
        <span class="icon b" style="--icon: var(--i-story-candidate)"></span>
      </div>
      <small style="margin-top:6px">overlay — <span style="color:light-dark(#d02f2f,#ff6b6b)">current</span> vs <span style="color:light-dark(#1a63d0,#6ea8ff)">candidate</span></small>
    </div>
    <div class="spec">
      <div><span class="icon" style="--icon: var(--i-story); --icon-size: 60px"></span></div>
      <small>current<br>20×20 · stroke 2</small>
    </div>
    <div class="spec">
      <div><span class="icon" style="--icon: var(--i-story-candidate); --icon-size: 60px"></span></div>
      <small>candidate<br>16×16 · stroke 1.5</small>
    </div>
    <div class="spec">
      <div><span class="icon" style="--icon: var(--i-reading); --icon-size: 60px"></span></div>
      <small>neighbour<br>16×16 · fill</small>
    </div>
  </div>
  <div class="side-by-side" style="margin-top:20px">
    <div class="spec">
      <div class="menu_sub" style="width:170px">
        <div class="menu_heading">${ico("story")}<p>Stories</p></div>
        <div class="menu_heading">${ico("reading")}<p>Reading</p></div>
        <div class="menu_heading">${ico("gear")}<p>Settings</p></div>
      </div>
      <small style="margin-top:6px">current story.svg</small>
    </div>
    <div class="spec">
      <div class="menu_sub" style="width:170px">
        <div class="menu_heading">${ico("story-candidate")}<p>Stories</p></div>
        <div class="menu_heading">${ico("reading")}<p>Reading</p></div>
        <div class="menu_heading">${ico("gear")}<p>Settings</p></div>
      </div>
      <small style="margin-top:6px">candidate — matched weight</small>
    </div>
  </div>
</section>

<section>
  <h2>8. The whole set</h2>
  <div class="grid">${gridCells}</div>
</section>

<script>
const root = document.documentElement
for (const b of document.querySelectorAll("[data-theme-set]")) {
  b.addEventListener("click", () => {
    const m = b.dataset.themeSet
    if (m === "system") root.removeAttribute("data-theme"); else root.setAttribute("data-theme", m)
    for (const o of document.querySelectorAll("[data-theme-set]")) o.setAttribute("aria-pressed", String(o === b))
  })
}
</script>
</body>
</html>
`

  fs.writeFileSync(OUT, html, "utf8")
  console.log("rescaled candidates -> " + CANDIDATE_DIR)
  for (const r of rescaled) {
    console.log("  " + r.name.padEnd(14) +
      (r.before * 100).toFixed(0).padStart(4) + "% -> " + (r.after * 100).toFixed(0) + "%")
  }
  console.log("story candidate fill: " + (storyCandidate.fill * 100).toFixed(0) + "%")
  console.log("written: " + OUT)
})()
