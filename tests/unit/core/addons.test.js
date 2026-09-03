const test = require("node:test")
const assert = require("node:assert/strict")
const {
  ADDON_PROTOCOL,
  addonContributionId,
  isAddonContributionId,
  parseAddonsText,
  presentAddons,
  projectStoryView,
  readAddonManifest,
  readAddonsDocument,
  renderAddonTemplate,
  storyMatchesCondition
} = require("../../../packages/core/dist/addons")

const manifest = () => ({
  protocol: ADDON_PROTOCOL,
  id: "archive-today",
  name: "Archive.today",
  version: "1.0.0",
  contributions: [
    {
      kind: "action",
      id: "open-archive",
      label: "Open archived copy",
      icon: "archive",
      surfaces: ["button", "menu", "swipe", "key"],
      when: { scheme: ["http", "https"], notDomain: ["archive.today"] },
      run: { open: "https://archive.today/newest/{href}", target: "blank" }
    },
    { kind: "badge", id: "score", when: { type: ["HN"] }, text: "{fields.score} pts" },
    { kind: "line", id: "note", text: "via {domain}" }
  ]
})

const story = (overrides = {}) => ({
  href: "https://example.org/a?x=1&y=2",
  title: "An <example> story",
  type: "HN",
  comment_url: "https://news.ycombinator.com/item?id=1",
  timestamp: 1700000000000,
  read_state: "unread",
  stared: false,
  tags: [{ class: "category", text: "ask" }],
  score: 42,
  _rev: "1-x",
  nested: { not: "scalar" },
  ...overrides
})

test("a story view carries the allow-listed fields and scalar extras only", () => {
  const view = projectStoryView(story(), "https://mirror.example.org/a")
  assert.equal(view.redirectedHref, "https://mirror.example.org/a")
  assert.equal(view.domain, "mirror.example.org")
  assert.equal(view.commentUrl, "https://news.ycombinator.com/item?id=1")
  assert.equal(view.timestamp, "2023-11-14T22:13:20.000Z")
  assert.deepEqual(view.tags, ["ask"])
  assert.deepEqual(view.fields, { score: 42 })
  assert.equal(Object.isFrozen(view), true)
  assert.equal("_rev" in view.fields, false)
})

test("conditions match by type, domain, scheme, tag, state, comments, and fields", () => {
  const view = projectStoryView(story())
  const cases = [
    [undefined, true],
    [{ type: ["HN"] }, true],
    [{ type: ["LO"] }, false],
    [{ domain: ["example.org"] }, true],
    [{ domain: ["*.example.org"] }, true],
    [{ domain: ["sub.example.org"] }, false],
    [{ notDomain: ["*.example.org"] }, false],
    [{ scheme: ["https"] }, true],
    [{ scheme: ["http"] }, false],
    [{ tag: ["ask", "show"] }, true],
    [{ tag: ["show"] }, false],
    [{ readState: ["read"] }, false],
    [{ stared: false }, true],
    [{ hasComments: true }, true],
    [{ field: { score: 42 } }, true],
    [{ field: { score: 41 } }, false]
  ]
  for (const [when, expected] of cases) {
    assert.equal(storyMatchesCondition(when, view), expected, JSON.stringify(when))
  }
})

test("templates encode values in URLs, pass them through in text, and refuse non-http results", () => {
  const view = projectStoryView(story())
  assert.equal(
    renderAddonTemplate("https://archive.today/newest/{href}", view, "url"),
    "https://archive.today/newest/https%3A%2F%2Fexample.org%2Fa%3Fx%3D1%26y%3D2"
  )
  assert.equal(renderAddonTemplate("{title} · {fields.score} · {fields.missing}", view, "text"),
    "An <example> story · 42 · ")
  assert.throws(() => renderAddonTemplate("javascript:{title}", view, "url"), /http\(s\)/)
  assert.throws(() => renderAddonTemplate("{domain}/x", view, "url"), /did not produce a URL/)
})

test("a well-formed manifest is accepted whole and ids are namespaced", () => {
  const read = readAddonManifest(manifest())
  assert.equal(read.ok, true)
  assert.equal(read.manifest.contributions.length, 3)
  assert.deepEqual(read.manifest.contributions[0].surfaces, ["button", "menu", "swipe", "key"])
  assert.equal(addonContributionId(read.manifest.id, "open-archive"), "addon:archive-today/open-archive")
  assert.equal(isAddonContributionId("addon:archive-today/open-archive"), true)
  assert.equal(isAddonContributionId("open"), false)
})

test("a manifest with any problem is rejected whole, and every problem is named", () => {
  const bad = manifest()
  bad.id = "Bad Id"
  bad.contributions[0].run = { open: "https://x/{nope}", copy: "x" }
  bad.contributions[1].when.type = "HN"
  bad.contributions.push({ kind: "widget", id: "w" })
  bad.contributions.push({ kind: "line", id: "note", text: "dup" })
  bad.script = "main.js"
  const read = readAddonManifest(bad)
  assert.equal(read.ok, false)
  const paths = read.reports.map((report) => report.path)
  for (const expected of [
    "id", "script", "contributions[0].run", "contributions[1].when.type",
    "contributions[3].kind", "contributions[4].id"
  ]) {
    assert.ok(paths.includes(expected), `${expected} in ${paths.join(", ")}`)
  }
  const scheme = manifest()
  scheme.contributions[0].run = { open: "javascript:alert({title})" }
  const schemeRead = readAddonManifest(scheme)
  assert.equal(schemeRead.ok, false)
  assert.match(schemeRead.reports[0].message, /http:\/\/ or https:\/\//)
  assert.equal(readAddonManifest("nope").ok, false)
  assert.equal(readAddonManifest({ ...manifest(), protocol: 2 }).ok, false)
})

test("scripted contributions need a pinned script, and message names are identifiers", () => {
  const { readSandboxMessage, readBadgeTexts } = require("../../../packages/core/dist/addons")
  const scripted = manifest()
  scripted.contributions = [
    { kind: "action", id: "ping", label: "Ping", run: { message: "ping" } },
    { kind: "badge", id: "score", compute: "score" }
  ]
  const missing = readAddonManifest(scripted)
  assert.equal(missing.ok, false)
  assert.deepEqual(missing.reports.map((report) => report.path), ["script"])

  scripted.script = { url: "https://addons.example/main.js", integrity: "sha256-" + "A".repeat(43) + "=" }
  const read = readAddonManifest(scripted)
  assert.equal(read.ok, true)
  assert.deepEqual(read.manifest.script, scripted.script)
  assert.deepEqual(read.manifest.contributions[1], { kind: "badge", id: "score", compute: "score", when: undefined })

  scripted.contributions[0].run = { message: "not an identifier" }
  scripted.script.integrity = "md5-nope"
  const bad = readAddonManifest(scripted)
  assert.equal(bad.ok, false)
  const paths = bad.reports.map((report) => report.path)
  assert.ok(paths.includes("contributions[0].run.message"), paths.join())
  assert.ok(paths.includes("script.integrity"), paths.join())

  assert.deepEqual(readSandboxMessage({ type: "ready", protocol: 1 }), { type: "ready", protocol: 1 })
  assert.equal(readSandboxMessage({ type: "op", op: { name: "openUrl", href: "https://a/", url: "file:///x" } }), null)
  assert.deepEqual(
    readSandboxMessage({ type: "op", requestId: 3, op: { name: "addTag", href: "https://a/", tag: "  paywall " } }),
    { type: "op", requestId: 3, op: { name: "addTag", href: "https://a/", tag: "paywall" } }
  )
  assert.deepEqual(readBadgeTexts(["a", 1], 3), ["a", "", ""])
})

test("defaults fill in: action group navigation, surfaces button and menu", () => {
  const read = readAddonManifest({
    ...manifest(),
    contributions: [{ kind: "action", id: "copy-it", label: "Copy it", run: { copy: "{href}" } }]
  })
  assert.equal(read.ok, true)
  assert.equal(read.manifest.contributions[0].group, "navigation")
  assert.deepEqual(read.manifest.contributions[0].surfaces, ["button", "menu"])
})

test("the addons document reads tolerantly and drops what does not validate", () => {
  const doc = readAddonsDocument({
    version: 1,
    addons: [
      { enabled: false, manifest: manifest() },
      { manifest: { ...manifest(), id: "broken", contributions: "no" } },
      "junk",
      { manifest: manifest() }
    ]
  })
  assert.equal(doc.addons.length, 1)
  assert.equal(doc.addons[0].enabled, false)
  assert.deepEqual(readAddonsDocument({ version: 2, addons: [] }).addons, [])
})

test("editor text round-trips through the document and reports errors loudly", () => {
  const text = JSON.stringify([{ enabled: false, ...manifest() }, { ...manifest(), id: "second" }])
  const doc = parseAddonsText(text)
  assert.deepEqual(doc.addons.map((entry) => [entry.manifest.id, entry.enabled]), [
    ["archive-today", false], ["second", true]
  ])
  const presented = presentAddons(doc)
  assert.deepEqual(parseAddonsText(presented), doc)
  assert.equal(presented.startsWith("[\n  {\n    \"enabled\": false,"), true)
  assert.equal(parseAddonsText("  ").addons.length, 0)
  assert.throws(() => parseAddonsText("{"), /Not valid JSON/)
  assert.throws(() => parseAddonsText(JSON.stringify([manifest(), manifest()])), /appears twice/)
  assert.throws(
    () => parseAddonsText(JSON.stringify([{ ...manifest(), version: "" }])),
    /\[0\]\.version must not be empty/
  )
})
