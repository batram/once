"use strict"

const childProcess = require("node:child_process")
const fs = require("node:fs")
const path = require("node:path")
const postcss = require("postcss")

const root = path.resolve(__dirname, "..")
const read = (file) => fs.readFileSync(path.join(root, file), "utf8")
const failures = []

const entry = postcss.parse(read("packages/ui-web/public/static/css/style.css"))
entry.walkAtRules("import", (rule) => {
  if (!/\blayer\([^)]+\)/.test(rule.params)) {
    failures.push(`Unlayered shared import: ${rule.params}`)
  }
})

for (const [file, layer] of [
  ["apps/electron/src/electron.css", "platform"],
  ["apps/mobile/src/mobile.css", "platform"],
  ["apps/electron/src/browser/error-page.css", "platform"],
  ["packages/ui-web/src/reader/readerDocument.css", "base"],
  ["packages/ui-web/src/presenters/outline/outline_style.css", "base"]
]) {
  const ast = postcss.parse(read(file), { from: file })
  const rules = ast.nodes.filter((node) => node.type !== "comment")
  if (rules.length !== 1 || rules[0].type !== "atrule" ||
      rules[0].name !== "layer" || rules[0].params !== layer) {
    failures.push(`${file} must contain one top-level @layer ${layer} block`)
  }
}

// A separate document does not load parts/vars.css, so every public token it
// consumes has to be declared inside it. An undeclared custom property is
// invalid at computed-value time and collapses to the initial value, which
// reads as a silently unstyled box rather than as an error.
const publicTokens = new Set()
postcss.parse(read("packages/ui-web/public/static/css/parts/vars.css"))
  .walkDecls((declaration) => {
    if (declaration.prop.startsWith("--")) publicTokens.add(declaration.prop)
  })

for (const file of [
  "apps/electron/src/browser/error-page.css",
  "packages/ui-web/src/reader/readerDocument.css",
  "packages/ui-web/src/presenters/outline/outline_style.css"
]) {
  const source = read(file)
  const ast = postcss.parse(source, { from: file })
  const declared = new Set()
  ast.walkDecls((declaration) => {
    if (declaration.prop.startsWith("--")) declared.add(declaration.prop)
  })
  const missing = new Set()
  ast.walkDecls((declaration) => {
    for (const match of declaration.value.matchAll(/var\(\s*(--[\w-]+)\s*(\)|,)/g)) {
      // A var() with a fallback survives an undeclared token, so only bare
      // references matter here.
      if (match[2] !== ")") continue
      if (publicTokens.has(match[1]) && !declared.has(match[1])) missing.add(match[1])
    }
  })
  for (const token of [...missing].sort()) {
    failures.push(`${file} consumes ${token} without declaring it`)
  }
}

for (const [file, marker] of [
  ["packages/ui-web/src/collectorStyles.ts", "style.textContent = `@layer components {"],
  ["packages/ui-web/src/picker/overlayStyles.ts", "`@layer components {"]
]) {
  if (!read(file).includes(marker)) {
    failures.push(`${file} generates trusted CSS outside a named layer`)
  }
}

const allowedImportant = new Set([
  "packages/ui-web/public/static/css/parts/base.css|.active_drag *|pointer-events",
  "packages/ui-web/public/static/css/parts/utilities.css|[hidden]|display",
  "packages/ui-web/public/static/css/parts/utilities.css|.visually_hidden|position",
  "packages/ui-web/public/static/css/parts/utilities.css|.visually_hidden|width",
  "packages/ui-web/public/static/css/parts/utilities.css|.visually_hidden|height",
  "packages/ui-web/public/static/css/parts/utilities.css|.visually_hidden|overflow",
  "packages/ui-web/public/static/css/parts/utilities.css|.visually_hidden|clip",
  "packages/ui-web/public/static/css/parts/utilities.css|.visually_hidden|white-space",
  "apps/mobile/src/mobile.css|body,*,*::before,*::after|scroll-behavior",
  "apps/mobile/src/mobile.css|body,*,*::before,*::after|transition-duration",
  "apps/mobile/src/mobile.css|body,*,*::before,*::after|animation-duration",
  "apps/mobile/src/mobile.css|body,*,*::before,*::after|animation-iteration-count"
])

const cssFiles = childProcess.execFileSync("git", ["ls-files", "*.css"], {
  cwd: root,
  encoding: "utf8"
}).trim().split(/\r?\n/).filter(Boolean)
for (const file of cssFiles) {
  const ast = postcss.parse(read(file), { from: file })
  ast.walkDecls((declaration) => {
    if (!declaration.important) return
    const selector = declaration.parent.selector.replace(/\s+/g, " ")
      .replace(/,\s+/g, ",").trim()
    const key = `${file}|${selector}|${declaration.prop}`
    if (!allowedImportant.has(key)) {
      failures.push(`Undocumented !important utility: ${key}`)
    }
  })
}

const sourceFiles = childProcess.execFileSync(
  "git",
  ["ls-files", "packages/ui-web/src/*.ts", "packages/ui-web/src/**/*.ts",
    "apps/electron/src/*.ts", "apps/electron/src/**/*.ts",
    "apps/mobile/src/*.ts", "apps/mobile/src/**/*.ts"],
  { cwd: root, encoding: "utf8" }
).trim().split(/\r?\n/).filter(Boolean)
const reviewedRuntimeProperties = new Set([
  "flex", "flexBasis", "height", "left", "lineHeight", "maxHeight", "minWidth",
  "opacity", "top", "transform", "transition", "width"
])
for (const file of sourceFiles) {
  read(file).split(/\r?\n/).forEach((line, index) => {
    if (/^\s*\/\//.test(line)) return
    for (const match of line.matchAll(/\.style\.([A-Za-z]+)\s*=/g)) {
      const property = match[1]
      const transientCursor = property === "cursor" &&
        file === "packages/ui-web/src/story/swipe/gesture.ts"
      if (!reviewedRuntimeProperties.has(property) && !transientCursor) {
        failures.push(`Static inline style requires review: ${file}:${index + 1} ${property}`)
      }
    }
    const setProperty = line.match(/\.style\.setProperty\(\s*["']([^"']+)/)
    if (setProperty && !setProperty[1].startsWith("--")) {
      failures.push(`Only custom properties may use setProperty: ${file}:${index + 1}`)
    }
    if (/\.style\.cssText\s*=/.test(line)) {
      failures.push(`cssText styling is forbidden: ${file}:${index + 1}`)
    }
  })
}

if (failures.length) {
  console.error(failures.join("\n"))
  process.exitCode = 1
} else {
  console.log("Cascade contract passed: trusted CSS is layered and inline styles are reviewed.")
}
