const { DOMParser } = require("linkedom")

function installDomGlobals() {
  globalThis.DOMParser = DOMParser
}

function parseDocument(source, type = "text/html") {
  installDomGlobals()
  return new DOMParser().parseFromString(source, type)
}

module.exports = { installDomGlobals, parseDocument }
