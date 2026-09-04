// The bundlers hand `import text from "./file.html?raw"` the file's text. Node
// has no such loader, so a unit test that reaches a module using it installs
// this: the query is dropped when resolving, and .html/.css files load as
// strings, the way the bundler's asset/source rule would give them.
const fs = require("node:fs")
const Module = require("node:module")

let installed = false

function installRawAssetLoader() {
  if (installed) return
  installed = true
  const resolve = Module._resolveFilename
  Module._resolveFilename = function (request, ...rest) {
    return resolve.call(this, request.replace(/\?raw$/, ""), ...rest)
  }
  for (const extension of [".html", ".css"]) {
    Module._extensions[extension] = (module, filename) => {
      module.exports = fs.readFileSync(filename, "utf8")
    }
  }
}

module.exports = { installRawAssetLoader }
