const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { adaptIOSExtension } = require("../../../scripts/adapt-ios-extension")
const packages = require("../../../scripts/ios-extension-packages")

test("iOS packages keep canonical Android extension IDs and verified upstream releases", () => {
  assert.deepEqual(packages.map(p => p.id), ["addon@darkreader.org", "sponsorBlocker@ajay.app", "{aecec67f-0d10-4fa7-b7c7-609a2db280cf}"])
  for (const item of packages) {
    assert.match(item.sha256, /^[a-f0-9]{64}$/)
    assert.equal(new URL(item.url).protocol, "https:")
  }
})

test("event-page adaptation retains upstream MV3 code, worlds and settings permissions", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "once-extension-"))
  try {
    const file = path.join(directory, "manifest.json")
    const manifest = {
      version: "1", manifest_version: 3, background: { service_worker: "background/index.js" },
      permissions: ["storage"], content_scripts: [{ world: "MAIN", js: ["inject/proxy.js"] }]
    }
    fs.writeFileSync(file, JSON.stringify(manifest))
    adaptIOSExtension(directory, { name: "Test", directory: "darkreader", version: "1", background: "event-page" })
    const adapted = JSON.parse(fs.readFileSync(file))
    assert.deepEqual(adapted, { ...manifest, background: { scripts: ["background/index.js"], persistent: false } })
    assert.throws(() => adaptIOSExtension(directory, { name: "Test", version: "2" }), /Unexpected/)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test("Violentmonkey adaptation preserves upstream execution assets and Android identity", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "once-vm-extension-"))
  try {
    const item = packages.find(p => p.directory === "violentmonkey")
    const manifest = {
      version: item.version, manifest_version: 2, description: "Userscripts",
      background: { scripts: ["background/index.js"] },
      browser_specific_settings: { gecko: { id: item.id } },
      commands: { _execute_browser_action: {} },
      content_scripts: [{ js: ["injected.js"], matches: ["<all_urls>"] }]
    }
    fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(manifest))
    fs.writeFileSync(path.join(directory, "injected.js"), "/* upstream script */")
    fs.mkdirSync(path.join(directory, "background"))
    const background = '/* GetScript:Ls; $a=e=>e.grant.some(Aa.test,Aa) */Gi.contains({permissions:["downloads"]});async function is(e,a,t){const o=+e[0]&&await $o.value.getMulti(e)};a.handleCommandMessage=Vm,a.deepCopy=aa,le.runtime.onMessage.addListener(Vm)'
    fs.writeFileSync(path.join(directory, "background/index.js"), background)
    adaptIOSExtension(directory, item)
    const adapted = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json")))
    assert.equal(adapted.background.persistent, false)
    assert.deepEqual(adapted.background.scripts, ["once-compat.js", "background/index.js"])
    assert.deepEqual(adapted.content_scripts, manifest.content_scripts)
    assert.equal(adapted.browser_specific_settings.gecko.id, item.id)
    assert.match(adapted.description, /Experimental/)
    assert.equal(fs.readFileSync(path.join(directory, "injected.js"), "utf8"), "/* upstream script */")
    assert.ok(fs.existsSync(path.join(directory, "LICENSE.once-bundle.txt")))
    assert.ok(fs.existsSync(path.join(directory, "once-compat.js")))
    assert.match(fs.readFileSync(path.join(directory, "background/index.js"), "utf8"), /onceRestoreValueOpeners/)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})
