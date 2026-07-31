"use strict"

const fs = require("node:fs")
const path = require("node:path")

const root = path.resolve(__dirname, "..")
const scannedRoots = ["apps", "packages"]
const textExtensions = new Set([".css", ".html", ".js", ".ts"])
const ignored = [
  /(^|\/)(dist|node_modules|build|out|\.webpack|public\/assets)(\/|$)/,
  /^apps\/mobile\/android\/app\/src\/main\/assets\/public\//,
  /^apps\/mobile\/ios\/App\/App\/public\//
]

function filesBelow(directory) {
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name)
    return entry.isDirectory() ? filesBelow(file) : [file]
  })
}

function relative(file) {
  return path.relative(root, file).split(path.sep).join("/")
}

function semanticControlViolations(fileName, source) {
  const violations = []
  const extension = path.extname(fileName)
  const legacyClass = extension === ".css"
    ? /(?:^|[,\s>+~])\.(?:btn|icon-btn|sub)(?=$|[\s:,.#>+~{])/m
    : extension === ".html"
      ? /\bclass\s*=\s*["'][^"']*\b(?:btn|icon-btn|sub)\b[^"']*["']/im
      : /["'`](?:btn|icon-btn|sub)["'`]|["'`][^"'`]*\.(?:btn|icon-btn|sub)(?=$|[\s:,.#>+~])[^"'`]*["'`]/m
  if (legacyClass.test(source)) {
    violations.push(`${fileName} contains a prohibited legacy control class`)
  }
  if (fileName.endsWith(".html")) {
    if (/<input\b[^>]*\btype\s*=\s*["']button["'][^>]*>/i.test(source)) {
      violations.push(`${fileName} contains <input type="button">`)
    }
    for (const match of source.matchAll(/<([a-z][\w-]*)\b[^>]*\bclass\s*=\s*["'][^"']*\bbutton\b[^"']*["'][^>]*>/gi)) {
      if (match[1].toLowerCase() !== "button") {
        violations.push(`${fileName} applies .button to <${match[1]}>`)
      }
    }
    for (const match of source.matchAll(/<button\b([^>]*)>/gi)) {
      const attributes = match[1]
      if (!/\btype\s*=\s*["'](?:button|submit)["']/i.test(attributes)) {
        violations.push(`${fileName} contains a button without an explicit type`)
      }
    }
    for (const match of source.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)) {
      const tag = match[1].toLowerCase()
      const attributes = match[2]
      if (
        !["button", "a", "input", "select", "textarea", "summary"].includes(tag) &&
        (/\bonclick\s*=/i.test(attributes) ||
          /\brole\s*=\s*["']button["']/i.test(attributes))
      ) {
        violations.push(`${fileName} contains clickable noninteractive <${tag}> markup`)
      }
    }
    for (const match of source.matchAll(
      /<button\b([^>]*\bclass\s*=\s*["'][^"']*\bbutton--icon\b[^"']*["'][^>]*)>/gi
    )) {
      if (!/\b(?:aria-label|aria-labelledby|title)\s*=\s*["'][^"']+["']/i.test(match[1])) {
        violations.push(`${fileName} contains an icon-only button without an accessible name`)
      }
    }
  }
  return violations
}

function main() {
  const violations = []
  const files = scannedRoots.flatMap((directory) => filesBelow(path.join(root, directory)))
  for (const file of files) {
    const fileName = relative(file)
    if (
      !textExtensions.has(path.extname(file)) ||
      ignored.some((pattern) => pattern.test(fileName)) ||
      fileName.startsWith("docs/tmp-icons/")
    ) continue
    violations.push(...semanticControlViolations(fileName, fs.readFileSync(file, "utf8")))
  }
  if (violations.length) {
    console.error("Semantic control contracts failed:")
    for (const violation of violations) console.error(`- ${violation}`)
    process.exitCode = 1
  } else {
    console.log("Semantic control contracts passed.")
  }
}

if (require.main === module) main()

module.exports = { semanticControlViolations }
