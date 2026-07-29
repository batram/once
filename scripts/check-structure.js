const fs = require("node:fs")
const path = require("node:path")
const ts = require("typescript")

const root = path.resolve(__dirname, "..")
const configPath = path.join(__dirname, "structure-exceptions.json")
const config = JSON.parse(fs.readFileSync(configPath, "utf8"))
const sourceExtensions = new Set([".ts", ".js", ".java", ".swift"])
const roots = ["apps", "packages", "scripts", "tests"]
const ignored = [
  /(^|\/)dist(\/|$)/,
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)(out|\.webpack|build|test-results|playwright-report)(\/|$)/,
  /^apps\/website\//,
  /^packages\/platform-web\//,
  /^apps\/mobile\/android\/gradle\//,
  /^apps\/mobile\/android\/app\/src\/main\/res\//,
  /^apps\/mobile\/ios\/App\/App\.xcodeproj\//,
  /^apps\/mobile\/ios\/App\/App\/public\//,
  /\.min\.js$/
]

function relative(file) {
  return path.relative(root, file).split(path.sep).join("/")
}

function filesBelow(directory) {
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name)
    return entry.isDirectory() ? filesBelow(entryPath) : [entryPath]
  })
}

function logicalLines(source) {
  return source.split(/\r?\n/).filter((line) => {
    const value = line.trim()
    return value && !value.startsWith("//")
  }).length
}

function functionName(node, sourceFile) {
  if (node.name?.getText) return node.name.getText(sourceFile)
  const parent = node.parent
  if (parent && ts.isVariableDeclaration(parent) && parent.name) {
    return parent.name.getText(sourceFile)
  }
  return "<anonymous>"
}

function functionViolations(file, source, limit, exceptions) {
  if (![".ts", ".js"].includes(path.extname(file))) return []
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.extname(file) === ".ts" ? ts.ScriptKind.TS : ts.ScriptKind.JS
  )
  const violations = []
  function visit(node) {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node)
    ) {
      const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
      const end = sourceFile.getLineAndCharacterOfPosition(node.end).line + 1
      const lines = end - start + 1
      const name = functionName(node, sourceFile)
      const key = `${relative(file)}#${name}`
      if (lines > limit && !exceptions.functions[key]) {
        violations.push(`${key} is ${lines} lines (limit ${limit})`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return violations
}

const violations = []
for (const file of roots.flatMap((directory) => filesBelow(path.join(root, directory)))) {
  const fileName = relative(file)
  if (!sourceExtensions.has(path.extname(file)) || ignored.some((rule) => rule.test(fileName))) {
    continue
  }
  const source = fs.readFileSync(file, "utf8")
  const isTest = fileName.startsWith("tests/")
  const fileLimit = isTest ? 800 : 600
  const functionLimit = isTest ? 180 : 120
  const lineCount = logicalLines(source)
  if (lineCount > fileLimit && !config.files[fileName]) {
    violations.push(`${fileName} is ${lineCount} logical lines (limit ${fileLimit})`)
  }
  violations.push(...functionViolations(file, source, functionLimit, config))
}

if (violations.length) {
  console.error("Structural limits failed:")
  for (const violation of violations) console.error(`- ${violation}`)
  process.exitCode = 1
} else {
  console.log("Structural limits passed.")
}
