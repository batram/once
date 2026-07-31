"use strict"

const childProcess = require("node:child_process")
const fs = require("node:fs")
const path = require("node:path")
const postcss = require("postcss")

const root = path.resolve(__dirname, "..")
const baselinePath = path.join(__dirname, "css-debt-baseline.json")
const phaseOneMigratedScopes = [
  "packages/ui-web/public/static/css/parts/base.css",
  "packages/ui-web/public/static/css/parts/menu.css",
  "packages/ui-web/public/static/css/parts/layout.css",
  "packages/ui-web/public/static/css/parts/stories.css",
  "packages/ui-web/public/static/css/parts/settings.css",
  "packages/ui-web/public/static/css/parts/notifications.css",
  "packages/ui-web/public/static/css/parts/dialogs.css",
  "packages/ui-web/public/static/css/parts/search.css",
  "apps/mobile/src/mobile.css",
  "apps/electron/src/electron.css",
  "apps/electron/src/browser/error-page.css"
]
const geometryProperty = /^(?:margin|padding)(?:-|$)|^(?:gap|row-gap|column-gap|font-size|border-radius)$/
const marginProperty = /^margin(?:-|$)/
const pxValue = /(?:^|[^\w.-])-?(?:\d*\.)?\d+px\b/i
const negativeValue = /(?:^|[\s,(])-(?:0*\.)?[1-9]\d*(?:\.\d+)?(?:px|%|em|rem|vh|vw)\b|calc\([^)]*-\s*(?:\d|\.)/i
const mobileAlias = /--m-(?:sp-\d+|fs-(?:title|body|meta|label)|touch)\b/g
// Both forms are the same debt: a shared component sheet deciding what it looks
// like per platform. The negated guard is the larger half and went uncounted,
// so it could grow freely. layer(platform) is what should express this.
const platformPrefixes = [
  [
    "mobile-specificity-prefix",
    /body\[data-platform=(?:"mobile"|'mobile')\]/
  ],
  [
    "desktop-specificity-prefix",
    /body:not\(\[data-platform=(?:"mobile"|'mobile')\]\)/
  ]
]

function normalized(value) {
  return value.trim().replace(/\s+/g, " ")
}

function ruleIdentity(container) {
  const conditions = []
  let owner = container
  if (container.type !== "rule") {
    conditions.push(`@${container.name} ${normalized(container.params || "")}`)
    owner = container.parent
  }
  for (let parent = owner.parent; parent; parent = parent.parent) {
    if (parent.type === "atrule") {
      conditions.unshift(`@${parent.name} ${normalized(parent.params || "")}`)
    }
  }
  if (owner.type === "rule") conditions.push(normalized(owner.selector))
  return conditions.join(" > ")
}

function debtId(kind, file, owner, detail) {
  return `${kind}|${file}|${normalized(owner)}|${normalized(detail)}`
}

function distinguishDuplicates(entries) {
  const totals = new Map()
  for (const entry of entries) {
    totals.set(entry, (totals.get(entry) || 0) + 1)
  }
  const seen = new Map()
  return entries.map((entry) => {
    if (totals.get(entry) === 1) return entry
    const occurrence = (seen.get(entry) || 0) + 1
    seen.set(entry, occurrence)
    return `${entry}|occurrence:${occurrence}`
  })
}

function analyzeCss(file, source) {
  const debts = []
  const ast = postcss.parse(source, { from: file })
  ast.walkRules((rule) => {
    const owner = ruleIdentity(rule)
    for (const [kind, pattern] of platformPrefixes) {
      if (pattern.test(rule.selector)) {
        debts.push(debtId(kind, file, owner, "platform selector"))
      }
    }
  })
  ast.walkDecls((declaration) => {
    const owner = ruleIdentity(declaration.parent)
    const detail = `${declaration.prop}: ${declaration.value}` +
      (declaration.important ? " !important" : "")
    for (const match of declaration.toString().matchAll(mobileAlias)) {
      debts.push(debtId("mobile-token-alias", file, owner, match[0]))
    }
    if (declaration.important) {
      debts.push(debtId("important", file, owner, detail))
    }
    if (geometryProperty.test(declaration.prop) && pxValue.test(declaration.value)) {
      debts.push(debtId("raw-geometry-px", file, owner, detail))
    }
    if (marginProperty.test(declaration.prop) && negativeValue.test(declaration.value)) {
      debts.push(debtId("negative-margin", file, owner, detail))
    }
  })
  return distinguishDuplicates(debts).sort()
}

function trackedCssFiles() {
  return childProcess.execFileSync(
    "git",
    ["ls-files", "*.css"],
    { cwd: root, encoding: "utf8" }
  ).trim().split(/\r?\n/).filter(Boolean)
}

function currentDebt() {
  return trackedCssFiles().flatMap((file) =>
    analyzeCss(file, fs.readFileSync(path.join(root, file), "utf8"))
  ).sort()
}

function compareDebt(expected, actual) {
  const expectedSet = new Set(expected)
  const actualSet = new Set(actual)
  return {
    added: actual.filter((entry) => !expectedSet.has(entry)),
    removed: expected.filter((entry) => !actualSet.has(entry))
  }
}

function main() {
  const actual = currentDebt()
  const platformPrefixDebt = actual.filter((entry) =>
    entry.startsWith("mobile-specificity-prefix|") ||
    entry.startsWith("desktop-specificity-prefix|")
  )
  if (platformPrefixDebt.length) {
    console.error("Platform-prefixed component rules remain after Phase 2:")
    for (const entry of platformPrefixDebt) console.error(`+ ${entry}`)
    process.exitCode = 1
    if (!process.argv.includes("--write-baseline")) return
  }
  const phaseOneRawGeometry = actual.filter((entry) =>
    entry.startsWith("raw-geometry-px|") &&
    phaseOneMigratedScopes.some((file) =>
      entry.startsWith(`raw-geometry-px|${file}|`)
    )
  )
  if (phaseOneRawGeometry.length) {
    console.error("Raw geometry remains in a completed Phase 1 scope:")
    for (const entry of phaseOneRawGeometry) console.error(`+ ${entry}`)
    process.exitCode = 1
    if (!process.argv.includes("--write-baseline")) return
  }
  if (process.argv.includes("--write-baseline")) {
    fs.writeFileSync(
      baselinePath,
      `${JSON.stringify({
        version: 2,
        identity: "file, at-rule context, selector, declaration",
        entries: actual
      }, null, 2)}\n`
    )
    console.log(`Wrote ${actual.length} CSS debt entries to ${path.relative(root, baselinePath)}.`)
    return
  }

  const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"))
  if (baseline.version !== 2) {
    console.error("CSS debt baseline must use stable identity version 2.")
    process.exitCode = 1
    return
  }
  const result = compareDebt(baseline.entries, actual)
  if (!result.added.length && !result.removed.length) {
    console.log(`CSS debt baseline matched (${actual.length} entries).`)
    return
  }
  if (result.added.length) {
    console.error("New or changed CSS debt:")
    for (const entry of result.added) console.error(`+ ${entry}`)
  }
  if (result.removed.length) {
    console.error("Removed CSS debt; shrink the baseline in the same change:")
    for (const entry of result.removed) console.error(`- ${entry}`)
  }
  process.exitCode = 1
}

if (require.main === module) main()

module.exports = {
  analyzeCss,
  compareDebt,
  currentDebt,
  phaseOneMigratedScopes
}
