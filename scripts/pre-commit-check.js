// Runs the per-file part of `npm run check:static` on what is being committed:
// eslint, stylelint, the structural limits and the semantic control contracts.
// Wired as the pre-commit hook by install-git-hooks.js; `git commit
// --no-verify` skips it. The whole-repo checks (knip, boundaries, css debt,
// cascade, line endings) stay in the pre-push hook, which runs all of them.
//
// Every check reads the staged blob, never the working-tree file: parallel
// work often leaves unstaged edits in this checkout, and those must neither
// block a commit nor hide a problem in what is actually committed.
const { execFileSync } = require("child_process")
const path = require("path")
const { fileViolations, isChecked } = require("./check-structure")
const { semanticControlViolations, isScanned } = require("./check-semantic-controls")

const root = path.resolve(__dirname, "..")
const lintedScripts = /\.(js|mjs|cjs|ts|tsx|jsx)$/
const lintedStyles = /^(apps|packages)\/.+\.css$/

const git = (args, input) => execFileSync("git", args, { cwd: root, input, maxBuffer: 256 * 1024 * 1024 })

// Added, copied, modified and renamed paths; a deletion leaves nothing to lint.
const staged = git(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"])
  .toString("utf8").split("\0").filter(Boolean)

// One `git cat-file --batch` reads every staged blob, rather than a process
// per file. Each answer is "<sha> <type> <size>\n<content>\n".
function readStaged(files) {
  const output = git(["cat-file", "--batch"], files.map(file => `:${file}\n`).join(""))
  const contents = new Map()
  let offset = 0
  for (const file of files) {
    const headerEnd = output.indexOf(10, offset)
    const size = Number(output.toString("utf8", offset, headerEnd).split(" ")[2])
    const content = output.subarray(headerEnd + 1, headerEnd + 1 + size)
    offset = headerEnd + 1 + size + 1
    // A NUL byte marks a binary blob, which none of the checks read.
    if (!content.includes(0)) contents.set(file, content.toString("utf8"))
  }
  return contents
}

async function lintScripts(sources) {
  if (sources.length === 0) return true
  const { ESLint } = require("eslint")
  const eslint = new ESLint({ cwd: root, warnIgnored: false })
  const results = []
  for (const [file, text] of sources) {
    results.push(...await eslint.lintText(text, { filePath: path.join(root, file) }))
  }
  const report = (await eslint.loadFormatter("stylish")).format(results)
  if (report) console.log(report)
  return results.every(result => result.errorCount === 0)
}

async function lintStyles(sources) {
  if (sources.length === 0) return true
  const stylelint = (await import("stylelint")).default
  let passed = true
  for (const [file, code] of sources) {
    const result = await stylelint.lint({ code, codeFilename: path.join(root, file), cwd: root, formatter: "string" })
    if (result.report) console.log(result.report)
    if (result.errored) passed = false
  }
  return passed
}

function reportViolations(title, violations) {
  if (violations.length === 0) return true
  console.error(`${title}:`)
  for (const violation of violations) console.error(`- ${violation}`)
  return false
}

async function main() {
  if (staged.length === 0) return
  const contents = readStaged(staged)
  const files = [...contents]
  // The exceptions that apply are the ones being committed alongside.
  const exceptions = JSON.parse(readStaged(["scripts/structure-exceptions.json"]).get("scripts/structure-exceptions.json"))
  const failed = []
  if (!await lintScripts(files.filter(([file]) => lintedScripts.test(file)))) failed.push("lint")
  if (!await lintStyles(files.filter(([file]) => lintedStyles.test(file)))) failed.push("lint:css")
  if (!reportViolations("Structural limits failed", files
    .filter(([file]) => isChecked(file))
    .flatMap(([file, source]) => fileViolations(file, source, exceptions)))) failed.push("check:structure")
  if (!reportViolations("Semantic control contracts failed", files
    .filter(([file]) => isScanned(file))
    .flatMap(([file, source]) => semanticControlViolations(file, source)))) failed.push("check:semantic-controls")
  if (failed.length > 0) {
    console.error(`\npre-commit: failed ${failed.join(", ")} on staged files. Fix them, or commit with --no-verify.`)
    process.exitCode = 1
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
