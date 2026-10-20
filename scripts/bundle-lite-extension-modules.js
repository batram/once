const fs = require("node:fs")
const path = require("node:path")
const ts = require("typescript")
const esbuild = require("esbuild")

function dependency(root, importer, name) {
  if (!name.startsWith(".") && !name.startsWith("/")) throw new Error(`Unsupported module: ${name}`)
  const file = path.resolve(name.startsWith("/") ? root : path.dirname(importer), name.startsWith("/") ? name.slice(1) : name)
  if (!file.startsWith(root + path.sep)) throw new Error("Module leaves extension package")
  return file
}

// Retain URLs imported by pages/workers outside the startup graph. These entry
// facades and the background share esbuild's chunks, so mutable module state
// has one instance in each document. Dynamic code itself is left untouched.
function entryPoints(root, graph) {
  const entries = new Set(["js/start.js"])
  for (const name of ["js/background.js", "js/static-net-filtering.js", "js/cosmetic-filtering.js", "js/console.js"]) {
    if (graph.has(name)) entries.add(name) // Existing runtime diagnostic entry points.
  }
  for (const relative of fs.readdirSync(root, { recursive: true }).map(name => name.split(path.sep).join("/")).filter(name => name.endsWith(".js"))) {
    const internal = graph.has(relative)
    const file = path.join(root, relative)
    const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, false, ts.ScriptKind.JS)
    const inspect = node => {
      const specifier = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) ? node.moduleSpecifier
        : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments[0] : null
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && !ts.isStringLiteral(specifier)) {
        throw new Error(`Dynamic module path needs review: ${relative}`)
      }
      if (specifier && ts.isStringLiteral(specifier) && /^[./]/.test(specifier.text)) {
        const name = path.relative(root, dependency(root, file, specifier.text)).split(path.sep).join("/")
        if (!internal && graph.has(name)) entries.add(name)
      }
      ts.forEachChild(node, inspect)
    }
    inspect(source)
  }
  // A module can also be loaded as a classic script by another page. Replacing
  // that URL with an ESM facade would break the page: fail explicitly instead.
  for (const relative of fs.readdirSync(root, { recursive: true }).map(name => name.split(path.sep).join("/")).filter(name => name.endsWith(".html"))) {
    const html = fs.readFileSync(path.join(root, relative), "utf8")
    for (const match of html.matchAll(/<script\b([^>]*)>/gi)) {
      const attrs = match[1]
      const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1]
      if (!src || /\btype\s*=\s*["']module["']/i.test(attrs)) continue
      const name = path.posix.normalize(src.startsWith("/") ? src.slice(1) : path.posix.join(path.posix.dirname(relative), src))
      if (entries.has(name)) throw new Error(`Classic script cannot become a module facade: ${name}`)
    }
  }
  return [...entries]
}

async function bundleStaticModules(directory, modules) {
  const root = fs.realpathSync(directory)
  if (fs.existsSync(path.join(root, "js/_once-start.js"))) throw new Error("Generated startup entry already exists")
  const entries = entryPoints(root, new Set(modules))
  // These upstream side-effect imports establish vAPI.defer and other globals
  // used at module top level. Splitting may otherwise hoist shared chunks first.
  const bootstrap = ["js/vapi-common.js", "js/vapi-background.js", "js/vapi-background-ext.js"].filter(name => modules.includes(name))
  const result = await esbuild.build({
    entryPoints: entries.map(name => path.join(root, name)), outbase: root, outdir: root,
    bundle: true, splitting: true, format: "esm", platform: "browser", target: "chrome120",
    treeShaking: false, minify: false, keepNames: true, legalComments: "eof",
    allowOverwrite: true, write: false, chunkNames: "_once_modules/[name]-[hash]",
    plugins: [{ name: "extension-modules", setup(build) {
      build.onResolve({ filter: /.*/ }, args => {
        if (args.kind === "dynamic-import") {
          const file = dependency(root, args.importer, args.path)
          return { path: "/" + path.relative(root, file).split(path.sep).join("/"), external: true }
        }
        if (args.kind !== "entry-point" && /^[./]/.test(args.path)) {
          const file = dependency(root, args.importer, args.path)
          const name = path.relative(root, file).split(path.sep).join("/")
          if (bootstrap.includes(name)) return { path: "/" + name, external: true }
          if (args.path.startsWith("/")) return { path: file }
        }
        return undefined
      })
    } }]
  })
  // esbuild finishes reading the original graph before any generated file is written.
  for (const output of result.outputFiles) {
    fs.mkdirSync(path.dirname(output.path), { recursive: true })
    fs.writeFileSync(output.path, output.contents)
  }
  if (bootstrap.length) {
    const entry = path.join(root, "js/start.js")
    fs.renameSync(entry, path.join(root, "js/_once-start.js"))
    const imports = bootstrap.map(name => `await import(${JSON.stringify("/" + name)});`).join("\n")
    fs.writeFileSync(entry, `${imports}\nawait import("./_once-start.js");\n`)
  }
  return entries
}
module.exports = { bundleStaticModules, entryPoints }
