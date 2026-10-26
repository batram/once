// Usage: node tests/e2e/mobile/run-ios-extension-compat.js <booted simulator UUID> [--only slug1,slug2] [--keep]
// Installs popular Firefox add-ons from addons.mozilla.org into the production
// WebExtensionHost on a simulator and reports how each one fares. Per-extension
// failures are findings; only a broken harness fails the run. Run
// `node scripts/fetch-ios-extensions.js` first so the bundled extensions exist.
// The XPIs are untrusted third-party archives: they stay under artifacts/ and
// only ever run inside the simulator app.
const fs = require("node:fs")
const path = require("node:path")
const os = require("node:os")
const crypto = require("node:crypto")
const { execFileSync } = require("node:child_process")
const { setTimeout: delay } = require("node:timers/promises")
const { downloadExtension } = require("../../../scripts/download-extension.js")

const root = path.resolve(__dirname, "../../..")
const bundleID = "com.once.compattest"
const hostSources = ["WebExtensionHost.swift", "WebExtensionManagement.swift", "WebExtensionInstaller.swift", "ExtensionArchive.swift", "ExtensionCatalogSnapshot.swift"]
const bundledDirectories = ["darkreader", "sponsorblock", "ublock-origin-lite", "violentmonkey"]
const downloads = path.join(root, "artifacts/extension-support/compat")
const outputs = path.join(root, "artifacts/extension-support")
const pollLimitMs = 20 * 60 * 1000
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, encoding: "utf8" }).trim()
// simctl complains loudly when there is nothing to terminate; that is the normal case here.
const terminate = device => { try { execFileSync("xcrun", ["simctl", "terminate", device, bundleID], { stdio: "ignore" }) } catch { /* not running */ } }

function parseArguments(argv) {
  const options = { only: null, keep: false, device: null }
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--only") options.only = argv[++index].split(",").map(slug => slug.trim()).filter(Boolean)
    else if (argv[index] === "--keep") options.keep = true
    else if (!options.device) options.device = argv[index]
  }
  if (!options.device) throw new Error("Pass the UUID of a booted iOS 18.4+ simulator")
  return options
}

const safeName = text => String(text).replace(/[^\w.-]/g, "_")

// Listing + verified XPI for one fixture entry; failures are recorded, never thrown.
async function fetchEntry(entry) {
  const result = { ...entry }
  try {
    const listing = JSON.parse((await downloadExtension(`https://addons.mozilla.org/api/v5/addons/addon/${encodeURIComponent(entry.slug)}/`)).toString())
    const file = listing.current_version?.file
    if (listing.type !== "extension" || !file?.url || !/^sha256:[a-f0-9]{64}$/.test(file.hash ?? "")) {
      throw new Error("Mozilla did not return a downloadable extension with a SHA-256 hash")
    }
    result.listing = {
      guid: listing.guid, version: listing.current_version.version, url: file.url, hash: file.hash,
      compatibility: listing.current_version.compatibility ?? {}, users: listing.average_daily_users
    }
    const target = path.join(downloads, safeName(entry.slug), `${safeName(listing.current_version.version)}.xpi`)
    const expected = file.hash.slice("sha256:".length)
    const digest = data => crypto.createHash("sha256").update(data).digest("hex")
    let data = fs.existsSync(target) ? fs.readFileSync(target) : null
    if (!data || digest(data) !== expected) {
      data = await downloadExtension(file.url)
      if (digest(data) !== expected) throw new Error(`Downloaded XPI does not match Mozilla's hash ${file.hash}`)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, data)
    }
    result.xpi = target
    result.bytes = data.length
  } catch (error) {
    result.listingError = error.message
    console.warn(`${entry.slug}: ${error.message}`)
  }
  return result
}

function buildApp(temporary, entries) {
  const app = path.join(temporary, "Host.app")
  const extensions = path.join(app, "public/extensions")
  fs.mkdirSync(extensions, { recursive: true })
  for (const name of bundledDirectories) {
    const source = path.join(root, "vendor/extensions", name === "ublock-origin-lite" ? name : `ios/${name}`)
    if (!fs.existsSync(source)) throw new Error(`Bundled extension ${name} is missing at ${source}; run node scripts/fetch-ios-extensions.js`)
    fs.cpSync(source, path.join(extensions, name), { recursive: true })
  }
  const compat = path.join(app, "compat")
  fs.mkdirSync(compat)
  const index = []
  for (const entry of entries) {
    if (!entry.xpi) continue
    const file = `${safeName(entry.slug)}.xpi`
    fs.copyFileSync(entry.xpi, path.join(compat, file))
    index.push({ slug: entry.slug, name: entry.name, file, version: entry.listing.version, guid: entry.listing.guid })
  }
  fs.writeFileSync(path.join(compat, "index.json"), JSON.stringify(index, null, 2))
  const info = path.join(app, "Info.plist")
  fs.writeFileSync(info, JSON.stringify({
    CFBundleIdentifier: bundleID, CFBundleName: "Extension Compat Test", CFBundleExecutable: "Host",
    CFBundlePackageType: "APPL", CFBundleVersion: "1", CFBundleShortVersionString: "1.0",
    MinimumOSVersion: "18.4", LSRequiresIPhoneOS: true, UILaunchScreen: {}
  }))
  run("plutil", ["-convert", "xml1", info])
  // The app's inspector switch is a Capacitor plugin; the host only asks it to track views.
  const inspector = path.join(temporary, "WebInspector.swift")
  fs.writeFileSync(inspector, "import WebKit\nenum WebInspector { static func track(_ view: WKWebView) { view.isInspectable = true } }\n")
  const sdk = run("xcrun", ["--sdk", "iphonesimulator", "--show-sdk-path"])
  const arch = process.arch === "arm64" ? "arm64" : "x86_64"
  run("xcrun", ["--sdk", "iphonesimulator", "swiftc", "-parse-as-library", "-target", `${arch}-apple-ios18.4-simulator`,
    "-sdk", sdk, path.join(__dirname, "ios-extension-compat.swift"),
    ...hostSources.map(name => `apps/mobile/ios/App/App/${name}`), inspector, "-o", path.join(app, "Host")])
  run("codesign", ["--force", "--sign", "-", app])
  return app
}

async function runOnSimulator(device, app, only) {
  terminate(device)
  run("xcrun", ["simctl", "uninstall", device, bundleID])
  run("xcrun", ["simctl", "install", device, app])
  const container = run("xcrun", ["simctl", "get_app_container", device, bundleID, "data"])
  const report = path.join(container, "Documents/results.json")
  fs.rmSync(report, { force: true })
  run("xcrun", ["simctl", "launch", device, bundleID, ...(only ? ["--only", only.join(",")] : [])])
  const deadline = Date.now() + pollLimitMs
  let result
  while (Date.now() < deadline) {
    await delay(500)
    if (!fs.existsSync(report)) continue
    try { result = JSON.parse(fs.readFileSync(report, "utf8")) } catch { continue }
    if (result.done) break
  }
  if (!result) throw new Error(`Native compat test produced no results within ${pollLimitMs / 60000} minutes`)
  if (!result.done) console.warn("Timed out waiting for the native test; keeping the partial results")
  terminate(device)
  return result
}

const cell = (text, limit = 120) => {
  const flat = String(text ?? "").replace(/\s+/g, " ").replace(/\|/g, "\\|").trim()
  return flat.length > limit ? flat.slice(0, limit - 1) + "…" : flat || "–"
}

function describe(entry) {
  const native = entry.native ?? {}
  const popup = native.popup ?? native.options
  const loaded = entry.listingError ? "not downloaded"
    : native.reviewError ? "review failed"
      : native.installError ? "install failed"
        : native.loaded == null ? "not reached"
          : native.loaded ? "yes" : "no"
  const errors = [entry.listingError, native.reviewError, native.installError, ...(native.warnings ?? []),
    ...(native.contextErrors ?? []), ...(native.backgroundErrors ?? []).slice(0, 2), ...(native.contentErrors ?? []).slice(0, 1),
    ...(popup?.errors ?? []).slice(0, 1), popup?.commandError, native.removeError, native.timeout ? "per-extension 60 s cap hit" : null]
  return {
    extension: `${native.name ?? entry.name} ${native.version ?? entry.listing?.version ?? ""}`.trim(),
    mv: native.manifestVersion ?? "–",
    loaded: loaded + (native.timeout ? " (timeout)" : ""),
    background: native.background == null ? "–" : `${native.background}${native.backgroundErrors?.length ? ` (${native.backgroundErrors.length} errors)` : ""}`,
    content: native.injects == null ? "–"
      : `${native.injects ? "matches" : "no match"}${native.pageMutated ? ", mutated" : ""}${native.contentErrors?.length ? ` (${native.contentErrors.length} errors)` : ""}`,
    popup: popup == null ? (native.loaded ? "none" : "–")
      : popup.kind === "action" && !native.actionPopup ? `action click${popup.opened ? " opened a page" : " (no popup)"}`
        : `${popup.kind === "action" ? "popup" : "options"} ${popup.opened ? "opened" : popup.noPage ? "no page" : "not opened"}${popup.textLength > 0 ? ` (${popup.textLength} chars)` : ""}`,
    adaptations: (native.adaptations ?? []).join("; "),
    limitations: errors.filter(Boolean).join("; "),
    ok: native.loaded === true
  }
}

function report(entries, native, timing) {
  const rows = entries.map(entry => ({ ...entry, native: native.extensions?.find(record => record.slug === entry.slug) }))
  const described = rows.map(describe)
  const lines = ["| Extension | MV | Loaded | Background | Content | Popup/Options | Adaptations | Limitations/errors |", "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...described.map(row => `| ${[row.extension, row.mv, row.loaded, row.background, row.content, row.popup, row.adaptations, row.limitations].map(value => cell(value)).join(" | ")} |`)]
  const loaded = described.filter(row => row.ok).length
  const summary = `${loaded} loaded / ${described.length - loaded} failed (${described.length} extensions, iOS ${native.os ?? "?"}, ${timing})`
  fs.mkdirSync(outputs, { recursive: true })
  fs.writeFileSync(path.join(outputs, "ios-compat-results.json"), JSON.stringify({
    generatedAt: new Date().toISOString(), os: native.os, done: native.done === true, failure: native.failure,
    baselineHtmlLength: native.baselineHtmlLength, bundleFailures: native.bundleFailures, catalog: native.catalog, elapsedMs: native.elapsedMs,
    extensions: rows
  }, null, 2))
  fs.writeFileSync(path.join(outputs, "ios-compat-report.md"), `# iOS extension compatibility\n\n${summary}\n\n${lines.join("\n")}\n`)
  console.log(lines.join("\n"))
  console.log(summary)
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const started = Date.now()
  let fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/ios-extension-compat.json"), "utf8"))
  if (options.only) fixtures = fixtures.filter(entry => options.only.includes(entry.slug))
  if (fixtures.length === 0) throw new Error("No fixture entries selected")
  fs.mkdirSync(downloads, { recursive: true })
  const entries = []
  for (const fixture of fixtures) entries.push(await fetchEntry(fixture))
  const downloaded = Date.now()
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "once-extension-compat-"))
  try {
    const app = buildApp(temporary, entries)
    const built = Date.now()
    const native = await runOnSimulator(options.device, app, options.only)
    const timing = `download ${Math.round((downloaded - started) / 1000)} s, build ${Math.round((built - downloaded) / 1000)} s, simulator ${Math.round((Date.now() - built) / 1000)} s`
    report(entries, native, timing)
    if (native.failure) throw new Error(`Native harness failure: ${native.failure}`)
  } finally {
    if (options.keep) console.log(`Build kept at ${temporary}`)
    else fs.rmSync(temporary, { recursive: true, force: true })
  }
  console.log(`Reports: ${path.join(outputs, "ios-compat-report.md")} and ios-compat-results.json`)
}

main().catch(error => { console.error(error); process.exitCode = 1 })
