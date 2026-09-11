const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

const root = path.resolve(__dirname, "../../..")
const version = require(path.join(root, "package.json")).version

for (const target of ["chrome", "firefox"]) {
  test(`${target} production artifact is complete and target-correct`, () => {
    const dist = path.join(root, "apps", `${target}-extension`, "dist", "release")
    const manifest = JSON.parse(fs.readFileSync(path.join(dist, "manifest.json"), "utf8"))
    assert.equal(manifest.manifest_version, target === "firefox" ? 2 : 3)
    assert.equal(manifest.version, version)
    for (const file of [
      "background.js",
      "sidepanel.js",
      "vendor-pouchdb.js",
      "vendor-readability.js",
      "reader-content.js",
      "addon-sandbox.js",
      "static/addon-sandbox.html",
      "static/sidepanel.html"
    ]) {
      assert.ok(fs.statSync(path.join(dist, file)).size > 0, `${file} must exist`)
    }
    const html = fs.readFileSync(path.join(dist, "static/sidepanel.html"), "utf8")
    assert.match(html, /\.\.\/vendor-pouchdb\.js/)
    assert.match(html, /\.\.\/vendor-readability\.js/)
    assert.match(html, /\.\.\/sidepanel\.js/)
    assert.doesNotMatch(html, /addon_sandbox_url_input/)
    assert.equal(fs.existsSync(path.join(dist, "static/addon-sandbox-hosted.html")), false)
    assert.equal(
      fs.readdirSync(path.join(dist, "static"), { recursive: true })
        .some((file) => file.endsWith(".ico")),
      false
    )
    if (target === "chrome") {
      assert.equal(manifest.background.service_worker, "background.js")
      assert.equal(manifest.side_panel.default_path, "static/sidepanel.html")
      assert.equal(manifest.minimum_chrome_version, "114")
    } else {
      assert.deepEqual(manifest.background.scripts, ["background.js"])
      assert.equal(manifest.sidebar_action.default_panel, "static/sidepanel.html")
      assert.ok(manifest.browser_specific_settings.gecko.id)
      assert.ok(manifest.browser_action)
      assert.equal(manifest.action, undefined)
      assert.equal(manifest.host_permissions, undefined)
      assert.ok(manifest.permissions.includes("<all_urls>"))
      assert.equal(manifest.content_security_policy, "script-src 'self' blob:; object-src 'none'")
    }
  })
}
