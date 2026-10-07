const assert = require("node:assert/strict")
const path = require("node:path")
const test = require("node:test")

const root = path.resolve(__dirname, "../../..")
const { planUserscripts, userscriptId } = require(path.join(root, "packages/core/dist/index.js"))

// The identity is enough to tell two texts apart, and keeps what a record
// holds readable when a case fails.
const hash = (value) => value

const source = (name, body) => `// ==UserScript==
// @name ${name}
// @namespace once-test
// @match https://example.org/*
// ==/UserScript==
${body}`

function entry(name, body, enabled = true) {
  return {
    id: userscriptId("once-test", name),
    name,
    source: source(name, body),
    enabled
  }
}

function installed(id, name, body, enabled = true) {
  return { id, namespace: "once-test", name, code: source(name, body), enabled }
}

function document(...scripts) {
  return { version: 1, scripts }
}

function record(id, script, enabled = true) {
  return { id, source: script.source, code: script.source, enabled }
}

test("a known storage generation allows deletion of the final dashboard script", () => {
  const script = entry("Last", "run()")
  const applied = { [script.id]: record(1, script) }
  const deleted = planUserscripts(document(script), [], applied, hash, true)
  assert.equal(deleted.adopted, true)
  assert.deepEqual(deleted.doc.scripts, [])
  assert.deepEqual(deleted.install, [])
  const reset = planUserscripts(document(script), [], applied, hash, false)
  assert.equal(reset.adopted, false)
  assert.deepEqual(reset.install, [script])
})

test("a settled script is left alone on both sides", () => {
  const script = entry("Probe", "one()")
  const plan = planUserscripts(
    document(script),
    [installed(1, "Probe", "one()")],
    { [script.id]: record(1, script) },
    hash
  )
  assert.equal(plan.adopted, false)
  assert.deepEqual(plan.install, [])
  assert.deepEqual(plan.toggle, [])
  assert.deepEqual(plan.remove, [])
  assert.deepEqual(plan.doc.scripts, [script])
})

test("an edit made in the dashboard is adopted instead of overwritten", () => {
  const script = entry("Probe", "one()")
  const plan = planUserscripts(
    document(script),
    [installed(1, "Probe", "edited()")],
    { [script.id]: record(1, script) },
    hash
  )
  assert.equal(plan.adopted, true)
  assert.deepEqual(plan.install, [])
  assert.equal(plan.doc.scripts[0].source, source("Probe", "edited()"))
  assert.equal(plan.keep[script.id].code, source("Probe", "edited()"))
})

test("the synced text wins when the document moved as well", () => {
  const stored = entry("Probe", "one()")
  const edited = entry("Probe", "two()")
  const plan = planUserscripts(
    document(edited),
    [installed(1, "Probe", "elsewhere()")],
    { [stored.id]: record(1, stored) },
    hash
  )
  assert.equal(plan.adopted, false)
  assert.deepEqual(plan.install, [edited])
  assert.deepEqual(plan.doc.scripts, [edited])
})

test("a script installed in the dashboard joins the document", () => {
  const script = entry("Probe", "one()")
  const plan = planUserscripts(
    document(script),
    [installed(1, "Probe", "one()"), installed(2, "Elsewhere", "other()", false)],
    { [script.id]: record(1, script) },
    hash
  )
  assert.equal(plan.adopted, true)
  assert.deepEqual(plan.doc.scripts.map((entry) => entry.name), ["Probe", "Elsewhere"])
  assert.equal(plan.doc.scripts[1].enabled, false)
  assert.deepEqual(plan.install, [])
  assert.deepEqual(plan.remove, [])
})

test("a switch flipped in the dashboard is adopted", () => {
  const script = entry("Probe", "one()")
  const plan = planUserscripts(
    document(script),
    [installed(1, "Probe", "one()", false)],
    { [script.id]: record(1, script) },
    hash
  )
  assert.equal(plan.adopted, true)
  assert.equal(plan.doc.scripts[0].enabled, false)
  assert.deepEqual(plan.toggle, [])
})

test("a switch flipped in Once is written to Violentmonkey", () => {
  const script = entry("Probe", "one()", false)
  const plan = planUserscripts(
    document(script),
    [installed(1, "Probe", "one()")],
    { [script.id]: { id: 1, source: script.source, code: script.source, enabled: true } },
    hash
  )
  assert.equal(plan.adopted, false)
  assert.deepEqual(plan.toggle, [{ id: 1, enabled: false }])
  assert.deepEqual(plan.install, [])
})

test("a deletion in the dashboard is adopted while its neighbours survive", () => {
  const kept = entry("Kept", "one()")
  const gone = entry("Gone", "two()")
  const plan = planUserscripts(
    document(kept, gone),
    [installed(1, "Kept", "one()")],
    { [kept.id]: record(1, kept), [gone.id]: record(2, gone) },
    hash
  )
  assert.equal(plan.adopted, true)
  assert.deepEqual(plan.doc.scripts, [kept])
  assert.deepEqual(plan.install, [])
  assert.deepEqual(plan.remove, [])
})

test("an emptied Violentmonkey is reinstalled rather than read as deletions", () => {
  const first = entry("First", "one()")
  const second = entry("Second", "two()")
  const plan = planUserscripts(
    document(first, second),
    [],
    { [first.id]: record(1, first), [second.id]: record(2, second) },
    hash
  )
  assert.equal(plan.adopted, false)
  assert.deepEqual(plan.install, [first, second])
  assert.deepEqual(plan.doc.scripts, [first, second])
})

test("a script dropped from the document is removed from Violentmonkey", () => {
  const kept = entry("Kept", "one()")
  const dropped = entry("Dropped", "two()")
  const plan = planUserscripts(
    document(kept),
    [installed(1, "Kept", "one()"), installed(2, "Dropped", "two()")],
    { [kept.id]: record(1, kept), [dropped.id]: record(2, dropped) },
    hash
  )
  assert.deepEqual(plan.remove, [2])
  // The dropped script is gone from Violentmonkey, so it is not adopted back.
  assert.deepEqual(plan.doc.scripts, [kept])
  assert.equal(plan.adopted, false)
})

test("a version 1 record has no baseline, so Once's copy is written once", () => {
  const script = entry("Probe", "one()")
  const plan = planUserscripts(
    document(script),
    [installed(1, "Probe", "elsewhere()")],
    { [script.id]: { id: 1 } },
    hash
  )
  assert.equal(plan.adopted, false)
  assert.deepEqual(plan.install, [script])
})
