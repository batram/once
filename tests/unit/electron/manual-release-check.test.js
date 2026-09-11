const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const ts = require("typescript")
const source = fs.readFileSync(path.resolve(__dirname, "../../../apps/electron/src/ManualReleaseCheck.ts"), "utf8")
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const loaded = { exports: {} }
Function("exports", "module", compiled)(loaded.exports, loaded)
const { checkLatestRelease, manualReleaseStatus } = loaded.exports

test("manual check reports the GitHub release and links to its tag without claiming a downgrade is an update", async () => {
  const result = await checkLatestRelease("2.0.0", async (url, options) => {
    assert.equal(url, "https://api.github.com/repos/batram/once/releases/latest")
    assert.equal(options.cache, "no-store")
    assert.ok(options.signal)
    return Response.json({ tag_name: "v1.0.0", draft: false, prerelease: false })
  })
  assert.equal(result.state, "idle")
  assert.equal(result.manual, true)
  assert.equal(result.message, "Latest release: v1.0.0. Installed version: 2.0.0.")
  assert.equal(result.releaseUrl, "https://github.com/batram/once/releases/tag/v1.0.0")
})

test("HTTP, network and malformed release failures retain a usable release-page link", async () => {
  for (const request of [
    async () => new Response(null, { status: 404 }),
    async () => new Response(null, { status: 403 }),
    async () => { throw new Error("offline") },
    async () => Response.json({ tag_name: "" }),
    async () => Response.json({ tag_name: "preview", prerelease: true })
  ]) {
    const result = await checkLatestRelease("0.3.0", request)
    assert.equal(result.state, "error")
    assert.equal(result.manual, true)
    assert.equal(result.releaseUrl, manualReleaseStatus().releaseUrl)
    assert.ok(result.message)
  }
})

test("the manual check says whether the published release is newer or the installed one", async () => {
  const release = (tag) => async () => Response.json({ tag_name: tag, draft: false, prerelease: false })
  assert.match((await checkLatestRelease("0.3.0", release("v0.4.0"))).message, /^A newer release is available: v0\.4\.0\. Installed version: 0\.3\.0\.$/)
  assert.match((await checkLatestRelease("0.4.0", release("v0.4.0"))).message, /^This is the latest release \(v0\.4\.0\)\.$/)
  assert.match((await checkLatestRelease("0.4.0", release("nightly"))).message, /^Latest release: nightly\. Installed version: 0\.4\.0\.$/)
  const limited = await checkLatestRelease("0.4.0", async () => new Response(null, { status: 403 }))
  assert.match(limited.message, /rate limiting/)
})

test("the manual status keeps the reason updates are manual in front of the hint", () => {
  assert.equal(manualReleaseStatus("Automatic updates are currently supported on Windows.").message,
    "Automatic updates are currently supported on Windows. Check GitHub for the latest release. Updates for this install are manual.")
  assert.equal(manualReleaseStatus().message, "Check GitHub for the latest release. Updates for this install are manual.")
})
