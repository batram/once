const fs = require("fs")
const path = require("path")

const root = path.resolve(__dirname, "..")
const baselinePath = path.join(__dirname, "core-boundary-baseline.json")
const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"))

const coreSrc = path.join(root, "packages", "core", "src")
const disallowedImports = ["@once/platform-webext", "@once/ui-web"]

function toPosix(relativePath) {
  return relativePath.split(path.sep).join("/")
}

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  return entries.flatMap((entry) => {
    const entryPath = path.join(dir, entry.name)
    if (entry.isDirectory()) return walk(entryPath)
    if (entry.isFile() && entry.name.endsWith(".ts")) return [entryPath]
    return []
  })
}

function importViolations(source) {
  const matches = new Set()
  const importPattern = /\b(?:import|export)\b[^"']*["']([^"']+)["']/g
  let match

  while ((match = importPattern.exec(source))) {
    const specifier = match[1]
    for (const disallowed of disallowedImports) {
      if (specifier === disallowed || specifier.startsWith(`${disallowed}/`)) {
        matches.add(disallowed)
      }
    }
  }

  return Array.from(matches).sort()
}

const actual = {}
for (const file of walk(coreSrc)) {
  const source = fs.readFileSync(file, "utf8")
  const violations = importViolations(source)
  if (violations.length > 0) {
    actual[toPosix(path.relative(root, file))] = violations
  }
}

const expected = baseline.disallowedImports
const errors = []

for (const [file, violations] of Object.entries(actual)) {
  const expectedViolations = expected[file] || []
  for (const violation of violations) {
    if (!expectedViolations.includes(violation)) {
      errors.push(`${file} imports ${violation}`)
    }
  }
}

for (const [file, expectedViolations] of Object.entries(expected)) {
  const actualViolations = actual[file] || []
  for (const violation of expectedViolations) {
    if (!actualViolations.includes(violation)) {
      errors.push(
        `${file} no longer imports ${violation}; update ${path.relative(
          root,
          baselinePath
        )}`
      )
    }
  }
}

if (errors.length > 0) {
  console.error("Boundary check failed:")
  for (const error of errors) {
    console.error(`- ${error}`)
  }
  process.exit(1)
}

const count = Object.values(actual).reduce(
  (total, violations) => total + violations.length,
  0
)
console.log(
  `Boundary check passed with ${count} known core import violation${
    count === 1 ? "" : "s"
  } tracked in ${path.relative(root, baselinePath)}.`
)
