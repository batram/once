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
  "apps/mobile/src/mobile.css",
  "apps/electron/src/electron.css"
]
const geometryProperty = /^(?:margin|padding)(?:-|$)|^(?:gap|row-gap|column-gap|font-size|border-radius)$/
const marginProperty = /^margin(?:-|$)/
const pxValue = /(?:^|[^\w.-])-?(?:\d*\.)?\d+px\b/i
const negativeValue = /(?:^|[\s,(])-(?:0*\.)?[1-9]\d*(?:\.\d+)?(?:px|%|em|rem|vh|vw)\b|calc\([^)]*-\s*(?:\d|\.)/i
const mobileAlias = /--m-(?:sp-\d+|fs-(?:title|body|meta|label)|touch)\b/g

function normalized(value) {
  return value.trim().replace(/\s+/g, " ")
}

function debtId(kind, file, line, detail) {
  return `${kind}|${file}:${line}|${normalized(detail)}`
}

function analyzeCss(file, source) {
  const debts = []
  const ast = postcss.parse(source, { from: file })
  source.split(/\r?\n/).forEach((line, index) => {
    for (const match of line.matchAll(mobileAlias)) {
      debts.push(debtId("mobile-token-alias", file, index + 1, match[0]))
    }
  })
  ast.walkRules((rule) => {
    if (/body\[data-platform=(?:"mobile"|'mobile')\]/.test(rule.selector)) {
      debts.push(debtId(
        "mobile-specificity-prefix",
        file,
        rule.source.start.line,
        rule.selector
      ))
    }
  })
  ast.walkDecls((declaration) => {
    const line = declaration.source.start.line
    const detail = `${declaration.prop}: ${declaration.value}` +
      (declaration.important ? " !important" : "")
    if (declaration.important) {
      debts.push(debtId("important", file, line, detail))
    }
    if (geometryProperty.test(declaration.prop) && pxValue.test(declaration.value)) {
      debts.push(debtId("raw-geometry-px", file, line, detail))
    }
    if (marginProperty.test(declaration.prop) && negativeValue.test(declaration.value)) {
      debts.push(debtId("negative-margin", file, line, detail))
    }
  })
  return debts.sort()
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
  const phaseOneRawGeometry = actual.filter((entry) =>
    entry.startsWith("raw-geometry-px|") &&
    phaseOneMigratedScopes.some((file) =>
      entry.startsWith(`raw-geometry-px|${file}:`)
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
      `${JSON.stringify({ version: 1, entries: actual }, null, 2)}\n`
    )
    console.log(`Wrote ${actual.length} CSS debt entries to ${path.relative(root, baselinePath)}.`)
    return
  }

  const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"))
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
