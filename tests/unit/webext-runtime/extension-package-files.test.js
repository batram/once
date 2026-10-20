// Scheme, loading an unpacked package, serving it, and its page policy: the
// parts every host shares, read here through the Node file adapter.
const assert = require("node:assert/strict")
const { createHash } = require("node:crypto")
const path = require("node:path")
const test = require("node:test")
const runtime = require("../../../packages/webext-runtime/dist")
const nodeHost = require("../../../packages/webext-runtime/dist/node")

const root = path.resolve(__dirname, "../../..")
const fixture = path.join(root, "tests/fixtures/extensions/blocker")

test("the built-in SHA-256 agrees with Node's", () => {
  for (const input of ["", "uBlock0@raymondhill.net", "a".repeat(55), "b".repeat(64), "c".repeat(1000)]) {
    assert.equal(runtime.sha256Hex(input), createHash("sha256").update(input).digest("hex"))
  }
  const bytes = new Uint8Array(300).map((_, index) => index % 251)
  assert.equal(runtime.sha256Hex(bytes), createHash("sha256").update(bytes).digest("hex"))
})

test("extension ids become stable opaque hosts and URLs parse back", () => {
  const host = runtime.hostForExtensionId("uBlock0@raymondhill.net")
  assert.match(host, /^[0-9a-f]{32}$/)
  assert.equal(host, runtime.hostForExtensionId("uBlock0@raymondhill.net"))
  assert.notEqual(host, runtime.hostForExtensionId("other@example.org"))
  const url = runtime.extensionUrl(host, "js/a b.js")
  assert.equal(url, `moz-extension://${host}/js/a b.js`)
  assert.deepEqual(runtime.parseExtensionUrl(url), { host, path: "/js/a b.js" })
  assert.deepEqual(runtime.parseExtensionUrl(`moz-extension://${host}/x?y#z`), { host, path: "/x" })
  assert.equal(runtime.parseExtensionUrl("https://example.org/"), null)
  assert.equal(runtime.isExtensionPageDocument("moz-extension://owner/page.html", "owner"), true)
  assert.equal(runtime.isExtensionPageDocument("https://example.test/page", "owner"), false)
  assert.equal(runtime.isExtensionPageDocument("about:blank", "owner"), false)
})

test("extension paths stay inside the package whichever slashes they use", () => {
  assert.equal(runtime.extensionFilePath("/js/a.js"), "js/a.js")
  assert.equal(runtime.extensionFilePath("js/./a.js"), "js/a.js")
  assert.equal(runtime.extensionFilePath("js/../css/x.css"), "css/x.css")
  assert.equal(runtime.extensionFilePath("/../manifest.json"), null)
  assert.equal(runtime.extensionFilePath("..\\manifest.json"), null)
  assert.equal(runtime.extensionFilePath("/"), null)
  assert.equal(runtime.mimeTypeFor("a/b.JS"), "text/javascript; charset=utf-8")
  assert.equal(runtime.mimeTypeFor("a.tar.gz"), "application/octet-stream")
})

test("an unpacked extension loads with its locale and a generated background page", async () => {
  const extension = await nodeHost.loadUnpackedExtension(fixture, "de")
  assert.equal(extension.id, "blocker@once.test")
  assert.equal(extension.name, "Once Test Blocker")
  assert.equal(extension.backgroundPage, runtime.GENERATED_BACKGROUND_PAGE)
  assert.equal(extension.manifest.permissions.has("webRequestBlocking"), true)
  assert.deepEqual(extension.manifest.hostPermissions, ["<all_urls>"])
  assert.equal(nodeHost.resolveExtensionFile(extension, "/../manifest.json"), null)
  assert.equal(nodeHost.resolveExtensionFile(extension, "/"), null)
  assert.equal(path.basename(nodeHost.resolveExtensionFile(extension, "background.js")), "background.js")
  assert.match(runtime.readExtensionText(extension, "/background.js"), /onBeforeRequest/)
  assert.equal(runtime.readExtensionText(extension, "../package.json"), null)
})

test("the protocol serves extension files, the generated page, and nothing outside", async () => {
  const extension = await nodeHost.loadUnpackedExtension(fixture, "en")
  const lookup = (host) => (host === extension.host ? extension : undefined)
  const serve = (p) => runtime.serveExtensionRequest(runtime.extensionUrl(extension.host, p), lookup)

  const page = await serve(runtime.GENERATED_BACKGROUND_PAGE)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /<script src="background\.js"><\/script>/)

  const script = await serve("background.js")
  assert.equal(script.headers.get("content-type"), "text/javascript; charset=utf-8")
  assert.match(await script.text(), /onBeforeRequest/)

  assert.equal((await serve("../package.json")).status, 404)
  assert.equal((await serve("missing.js")).status, 404)
  assert.equal((await runtime.serveExtensionRequest("moz-extension://nobody/x", lookup)).status, 404)
})

test("extension pages carry Firefox's default policy unless the manifest declares one", async () => {
  const extension = await nodeHost.loadUnpackedExtension(fixture, "en")
  const lookup = (host) => (host === extension.host ? extension : undefined)
  const serve = (p) => runtime.serveExtensionRequest(runtime.extensionUrl(extension.host, p), lookup)
  const mv2Default = "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';"
  assert.equal((await serve(runtime.GENERATED_BACKGROUND_PAGE)).headers.get("content-security-policy"), mv2Default)
  assert.equal((await serve("background.js")).headers.get("content-security-policy"), mv2Default)

  const policy = (rawManifest) => runtime.extensionPagePolicy({ ...extension, rawManifest })
  assert.equal(policy({ manifest_version: 2, content_security_policy: "script-src 'self' 'unsafe-eval'" }),
    "script-src 'self' 'unsafe-eval'")
  assert.equal(policy({ manifest_version: 3 }), "script-src 'self'; upgrade-insecure-requests;")
  assert.equal(policy({ manifest_version: 3, content_security_policy: { extension_pages: "script-src 'self'" } }),
    "script-src 'self'")
  // An MV2-style string means nothing to MV3, which keeps its default.
  assert.equal(policy({ manifest_version: 3, content_security_policy: "script-src *" }),
    "script-src 'self'; upgrade-insecure-requests;")
  assert.match(runtime.generatedBackgroundHtml(["worker.js"], true), /<script type="module" src="worker.js">/)
  assert.doesNotMatch(runtime.generatedBackgroundHtml(["bg.js"]), /module/)
})

test("an in-memory file reader serves a host that has no file system", async () => {
  const files = new Map([
    ["manifest.json", JSON.stringify({
      manifest_version: 2, name: "Mem", version: "1", browser_specific_settings: { gecko: { id: "mem@once.test" } },
      icons: { 16: "icon.png" }
    })],
    ["icon.png", new Uint8Array([137, 80, 78, 71])]
  ])
  const reader = { read: (relativePath) => files.get(relativePath) ?? null }
  const extension = await runtime.loadExtension("memory", reader, "en")
  assert.equal(extension.name, "Mem")
  assert.equal(await runtime.extensionIconDataUrl(extension), "data:image/png;base64,iVBORw==")
  const response = await runtime.serveExtensionRequest(runtime.extensionUrl(extension.host, "icon.png"), () => extension)
  assert.equal(response.headers.get("content-type"), "image/png")
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [137, 80, 78, 71])
})

test("native asset resolution uses protocol permissions without reading package bytes", async () => {
  const loaded = await nodeHost.loadUnpackedExtension(fixture, "en")
  const extension = { ...loaded, files: { read() { throw Error("Resolution must not read bytes") } } }
  const lookup = host => host === extension.host ? extension : undefined
  const url = path => runtime.extensionUrl(extension.host, path)
  const own = runtime.resolveExtensionRequest(url("background.js"), lookup)
  assert.equal(own.file, "background.js")
  assert.equal(own.extension, extension)
  assert.equal(own.headers["content-type"], "text/javascript; charset=utf-8")
  assert.equal(own.headers["content-security-policy"], runtime.extensionPagePolicy(extension))
  const denied = runtime.resolveExtensionRequest(url("background.js"), lookup, { webAccessibleOnly: true })
  assert.equal(denied.status, 404)
  assert.equal(runtime.resolveExtensionRequest(url("../outside.txt"), lookup).file, "outside.txt", "URL normalization stays within the same package")
  assert.equal(runtime.resolveExtensionRequest(url("%2e%2e%2foutside.txt"), lookup).status, 404)
  assert.equal(runtime.resolveExtensionRequest("moz-extension://unknown/x", lookup).status, 404)
  const generated = runtime.resolveExtensionRequest(url(runtime.GENERATED_BACKGROUND_PAGE), lookup)
  assert.equal(generated.status, 200)
  assert.match(await generated.text(), /background\.js/)
  const grant = new runtime.OwnPageRequests()
  grant.grant(url("background.js"))
  assert.equal(runtime.resolveExtensionRequest(url("background.js"), lookup, { webAccessibleOnly: true, ownPages: grant }).file, "background.js")
  assert.equal(runtime.resolveExtensionRequest(url("background.js"), lookup, { webAccessibleOnly: true, ownPages: grant }).status, 404)
})
