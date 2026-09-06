const test = require("node:test")
const assert = require("node:assert/strict")
const { readBrowserExtensionSync } = require("@once/core")

test("extension sync excludes unselected data and retains deletion markers", () => {
  const result = readBrowserExtensionSync({ version: 1, extensions: { addon: {
    local: ["theme", "removed", "theme"], sync: ["enabled"],
    values: { local: { theme: "dark", token: "never sync this" }, sync: { enabled: false, identity: "private" } }
  } } })
  assert.deepEqual(result.extensions.addon, {
    local: ["removed", "theme"], sync: ["enabled"],
    values: { local: { theme: "dark" }, sync: { enabled: false } }
  })
  assert.deepEqual(readBrowserExtensionSync(null), { version: 1, extensions: {} })
})

test("extension IDs and storage keys cannot change object prototypes", () => {
  const value = JSON.parse('{"extensions":{"__proto__":{"local":["__proto__"],"sync":[],"values":{"local":{"__proto__":{"test":1}},"sync":{}}}}}')
  const doc = readBrowserExtensionSync(value)
  assert.equal(Object.getPrototypeOf(doc.extensions), Object.prototype)
  assert.equal(Object.hasOwn(doc.extensions, "__proto__"), true)
  assert.deepEqual(doc.extensions.__proto__.values.local.__proto__, { test: 1 })
})
