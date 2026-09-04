const test = require("node:test")
const assert = require("node:assert/strict")
const { parseHTML } = require("linkedom")

const { registerCollector } = require("../../../packages/collectors/dist/registry")
const {
  SourceConfigFields
} = require("../../../packages/ui-web/dist/settings/structured/sourceConfig")

// The source form's configuration rows come from the selected collector's
// schema. A fake add-on collector stands in for one registered by a manifest.
const SCHEMA = {
  type: "object",
  properties: {
    prefix: { type: "string", description: "Title prefix", default: "" },
    limit: { type: "number", minimum: 1, maximum: 50 },
    mode: { type: "string", enum: ["all", "top"] },
    deep: { type: "object", properties: { key: { type: "string" } } }
  },
  required: ["mode"]
}

function withDom(callback) {
  const { window } = parseHTML("<main></main>")
  const previous = {}
  for (const name of ["document", "window", "Node", "HTMLElement", "HTMLInputElement", "HTMLSelectElement", "HTMLTextAreaElement"]) {
    previous[name] = globalThis[name]
    globalThis[name] = window[name] || window.document
  }
  try {
    return callback(window)
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) Reflect.deleteProperty(globalThis, name)
      else globalThis[name] = value
    }
  }
}

test("configuration rows follow the collector and save the validated select", () => {
  const release = registerCollector({
    options: { id: "addon:test/cfg", type: "ZQ", description: "Test", pattern: [], collects: "json",
      colors: ["#000", "#fff"], configSchema: SCHEMA },
    parse: () => []
  })
  try {
    withDom((window) => {
      const rows = window.document.querySelector("main")
      const fields = new SourceConfigFields({ prefix: "Old ", limit: 3 })

      // Auto-detect: no schema, nothing rendered, the stored select passes through.
      fields.render({ value: "" }, rows)
      assert.equal(rows.hidden, true)
      assert.deepEqual(fields.read(), { ok: true, select: { prefix: "Old ", limit: 3 } })

      fields.render({ value: "addon:test/cfg" }, rows)
      assert.equal(rows.hidden, false)
      const prefix = rows.querySelector('[data-testid="source-config-prefix"]')
      const limit = rows.querySelector('[data-testid="source-config-limit"]')
      const mode = rows.querySelector('[data-testid="source-config-mode"]')
      const deep = rows.querySelector('[data-testid="source-config-deep"]')
      assert.equal(prefix.value, "Old ")
      assert.equal(limit.value, "3")
      assert.equal(limit.getAttribute("max"), "50")
      assert.equal(mode.tagName, "SELECT")
      assert.equal(mode.required, true)
      assert.equal(deep.tagName, "TEXTAREA")
      assert.match(rows.textContent, /Title prefix/)

      // Every change is kept; the save validates the whole object and drops blanks.
      prefix.value = "New "
      prefix.dispatchEvent(new window.Event("change"))
      limit.value = ""
      limit.dispatchEvent(new window.Event("change"))
      mode.querySelector('option[value="all"]').selected = false
      mode.querySelector('option[value="top"]').selected = true
      mode.dispatchEvent(new window.Event("change"))
      deep.textContent = '{"key": "v"}'
      deep.dispatchEvent(new window.Event("change"))
      assert.deepEqual(fields.read(), { ok: true, select: { prefix: "New ", mode: "top", deep: { key: "v" } } })

      // A field the schema refuses names itself instead of saving.
      limit.value = "99"
      limit.dispatchEvent(new window.Event("change"))
      assert.deepEqual(fields.read(), { ok: false, message: "limit must be at most 50" })
      limit.value = "5"
      limit.dispatchEvent(new window.Event("change"))
      deep.textContent = "{nope"
      deep.dispatchEvent(new window.Event("change"))
      assert.deepEqual(fields.read(), { ok: false, message: "deep must be valid JSON" })

      // Switching away and back keeps what was typed.
      fields.render({ value: "" }, rows)
      fields.render({ value: "addon:test/cfg" }, rows)
      assert.equal(rows.querySelector('[data-testid="source-config-prefix"]').value, "New ")
    })
  } finally {
    release()
  }
})
