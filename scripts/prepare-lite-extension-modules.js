// Prepare only the generated Lite copy of uBlock: bundle static modules and
// preload their chunks. Keep the vendored package and dynamic code untouched.
const fs = require("node:fs")
const path = require("node:path")
const ts = require("typescript")

function staticModules(root, entry) {
  const visited = new Set()
  const visit = relative => {
    if (visited.has(relative)) return
    const file = path.resolve(root, relative)
    if (!file.startsWith(path.resolve(root) + path.sep)) throw new Error("Module leaves extension package")
    visited.add(relative)
    const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, false, ts.ScriptKind.JS)
    if (source.parseDiagnostics.length) throw new Error(`Cannot parse extension module: ${relative}`)
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue
      const specifier = statement.moduleSpecifier
      if (!specifier || !ts.isStringLiteral(specifier)) continue
      const name = specifier.text
      if (!name.startsWith(".") && !name.startsWith("/")) throw new Error(`Unsupported extension module specifier: ${name}`)
      const dependency = path.posix.normalize(name.startsWith("/") ? name.slice(1) : path.posix.join(path.posix.dirname(relative), name))
      visit(dependency)
    }
  }
  visit(entry)
  return [...visited]
}

function prepare(root) {
  const file = path.join(root, "background.html")
  const html = fs.readFileSync(file, "utf8")
  if (!/<script\b[^>]*src="js\/start\.js"[^>]*type="module"/.test(html)) throw new Error("Unexpected uBlock background entry")
  const modules = staticModules(root, fs.existsSync(path.join(root, "js/_once-start.js")) ? "js/_once-start.js" : "js/start.js")
  const escape = value => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")
  const hints = modules.map(module => `<link rel="modulepreload" href="${escape(module)}">`).join("\n")
  const marker = /<!-- Once Lite module preloads -->[\s\S]*?<!-- End Once Lite module preloads -->\n?/g
  const clean = html.replace(marker, "")
  if (!clean.includes("</head>")) throw new Error("Missing background document head")
  fs.writeFileSync(file, clean.replace("</head>", `<!-- Once Lite module preloads -->\n${hints}\n<!-- End Once Lite module preloads -->\n</head>`))
  return modules
}

if (require.main === module) {
  if (process.argv.length !== 3) throw new Error("Usage: prepare-lite-extension-modules <generated-extension-directory>")
  const root = process.argv[2]
  require("./bundle-lite-extension-modules").bundleStaticModules(root, staticModules(root, "js/start.js"))
    .then(() => console.log(`Once Lite: preloading ${prepare(root).length} bundled uBlock modules`))
    .catch(error => { console.error(error); process.exitCode = 1 })
}
module.exports = { staticModules, prepare }
