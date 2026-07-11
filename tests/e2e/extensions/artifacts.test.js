const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

const root = path.resolve(__dirname, "../../..")
const version = require(path.join(root, "package.json")).version

for (const target of ["chrome", "firefox"]) {
  test(`${target} production artifact is complete and target-correct`, () => {
    const dist = path.join(root, "apps", `${target}-extension`, "dist")
    const manifest = JSON.parse(fs.readFileSync(path.join(dist, "manifest.json"), "utf8"))
    assert.equal(manifest.manifest_version, 3)
    assert.equal(manifest.version, version)
    for (const file of ["background.js", "sidepanel.js", "reader-content.js", "static/sidepanel.html"]) {
      assert.ok(fs.statSync(path.join(dist, file)).size > 0, `${file} must exist`)
    }
    const html = fs.readFileSync(path.join(dist, "static/sidepanel.html"), "utf8")
    assert.match(html, /\.\.\/sidepanel\.js/)
    if (target === "chrome") {
      assert.equal(manifest.background.service_worker, "background.js")
      assert.equal(manifest.side_panel.default_path, "static/sidepanel.html")
      assert.equal(manifest.minimum_chrome_version, "114")
    } else {
      assert.deepEqual(manifest.background.scripts, ["background.js"])
      assert.equal(manifest.sidebar_action.default_panel, "static/sidepanel.html")
      assert.ok(manifest.browser_specific_settings.gecko.id)
    }
  })
}
