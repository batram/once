const fs = require("node:fs")
const path = require("node:path")
const ts = require("typescript")

const root = path.resolve(__dirname, "..")
const configPath = path.join(__dirname, "structure-exceptions.json")
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
  /^apps\/mobile\/android\/app\/src\/main\/assets\/public\//,
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

function isIgnored(fileName) {
  return ignored.some((rule) => rule.test(fileName))
}

// Comments are prose, not code, so they must not count against a file's budget.
// Line comments and `/* */` runs are removed before counting; quoted text is
// preserved so a "/*" inside a string cannot swallow the rest of the file.
function withoutComments(source) {
  let output = ""
  let index = 0
  let quote = ""
  while (index < source.length) {
    const character = source[index]
    const pair = source.slice(index, index + 2)
    if (quote) {
      if (character === "\\") {
        output += source.slice(index, index + 2)
        index += 2
        continue
      }
      // A template literal spans lines; an unterminated quote of either other
      // kind ends at the newline rather than eating the rest of the file.
      if (character === quote || (character === "\n" && quote !== "`")) quote = ""
      output += character
      index += 1
      continue
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character
      output += character
      index += 1
      continue
    }
    if (pair === "//") {
      while (index < source.length && source[index] !== "\n") index += 1
      continue
    }
    if (pair === "/*") {
      index += 2
      while (index < source.length && source.slice(index, index + 2) !== "*/") {
        if (source[index] === "\n") output += "\n"
        index += 1
      }
      index += 2
      continue
    }
    output += character
    index += 1
  }
  return output
}

function logicalLines(source) {
  return withoutComments(source)
    .split(/\r?\n/)
    .filter((line) => line.trim()).length
}

function contextualName(node, sourceFile) {
  const parent = node.parent
  if (!parent) return ""
  if (
    (ts.isVariableDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isBindingElement(parent)) &&
    parent.name
  ) {
    return parent.name.getText(sourceFile)
  }
  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    parent.right === node
  ) {
    return parent.left.getText(sourceFile)
  }
  // A callback argument is named by its call: `test("story groups collapse")`.
  // Without a literal label the callee alone would name every callback it takes,
  // so those fall through to a position instead.
  if (ts.isCallExpression(parent) && parent.arguments.includes(node)) {
    const label = parent.arguments.find((argument) => ts.isStringLiteralLike(argument))
    return label ? `${parent.expression.getText(sourceFile)}(${label.text})` : ""
  }
  return ""
}

// Exception keys must name one function, so an unnamed function borrows the
// name of what declares it and is qualified by its enclosing scopes. Only when
// nothing names it does the key fall back to a position, which stops a single
// entry from exempting every future unnamed function in the file.
function functionName(node, sourceFile) {
  const own = node.name?.getText
    ? node.name.getText(sourceFile)
    : ts.isConstructorDeclaration(node)
      ? "constructor"
      : contextualName(node, sourceFile) ||
        `<anonymous@${sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1}>`
  const scopes = []
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isClassLike(parent) || ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent)) {
      if (parent.name?.getText) scopes.unshift(parent.name.getText(sourceFile))
    }
  }
  return [...scopes, own].join(".")
}

// Every function in a file, keyed the way an exception entry must spell it.
function functionEntries(fileName, source) {
  if (![".ts", ".js"].includes(path.extname(fileName))) return []
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.extname(fileName) === ".ts" ? ts.ScriptKind.TS : ts.ScriptKind.JS
  )
  const entries = []
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
      entries.push({
        key: `${fileName}#${functionName(node, sourceFile)}`,
        lines: end - start + 1
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return entries
}

function fileViolations(fileName, source, exceptions) {
  const isTest = fileName.startsWith("tests/")
  const fileLimit = isTest ? 800 : 600
  const functionLimit = isTest ? 180 : 120
  const violations = []
  const lineCount = logicalLines(source)
  if (lineCount > fileLimit && !exceptions.files[fileName]) {
    violations.push(`${fileName} is ${lineCount} logical lines (limit ${fileLimit})`)
  }
  for (const entry of functionEntries(fileName, source)) {
    if (entry.lines > functionLimit && !exceptions.functions[entry.key]) {
      violations.push(`${entry.key} is ${entry.lines} lines (limit ${functionLimit})`)
    }
  }
  return violations
}

function main() {
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"))
  const violations = []
  for (const file of roots.flatMap((directory) => filesBelow(path.join(root, directory)))) {
    const fileName = relative(file)
    if (!sourceExtensions.has(path.extname(file)) || isIgnored(fileName)) {
      continue
    }
    violations.push(...fileViolations(fileName, fs.readFileSync(file, "utf8"), config))
  }
  if (violations.length) {
    console.error("Structural limits failed:")
    for (const violation of violations) console.error(`- ${violation}`)
    process.exitCode = 1
  } else {
    console.log("Structural limits passed.")
  }
}

if (require.main === module) main()

module.exports = { logicalLines, functionEntries, fileViolations, isIgnored }
