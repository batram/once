const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")
const engine = require("../../../apps/mobile/scripts/android-engine")

const root = path.resolve(__dirname, "../../..")
const app = path.join(root, "apps/mobile/android/app")

function javaFiles(directory) {
  const files = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...javaFiles(full))
    else if (entry.name.endsWith(".java")) files.push(full)
  }
  return files
}

test("the engine helper names Gradle tasks, APKs and packages for both engines", () => {
  assert.equal(engine.mobileEngine(undefined), "gecko")
  assert.equal(engine.mobileEngine("lite"), "lite")
  assert.throws(() => engine.mobileEngine("webkit"), /gecko or lite/)
  assert.equal(engine.gradleTask("gecko", "dev"), "assembleGeckoDevelopmentDebug")
  assert.equal(engine.gradleTask("lite", "dev"), "assembleLiteDevelopmentDebug")
  assert.equal(engine.gradleTask("lite", "release"), "assembleLiteProductionDebug")
  assert.equal(engine.gradleTask("lite", "release", "bundle"), "bundleLiteProductionRelease")
  assert.equal(engine.apkPath("gecko", "dev"), "android/app/build/outputs/apk/geckoDevelopment/debug/app-gecko-development-debug.apk")
  assert.equal(engine.apkPath("lite", "dev"), "android/app/build/outputs/apk/liteDevelopment/debug/app-lite-development-debug.apk")
  assert.equal(engine.apkPath("lite", "release"), "android/app/build/outputs/apk/liteProduction/debug/app-lite-production-debug.apk")
  assert.deepEqual(
    [engine.packageName("gecko", "release"), engine.packageName("gecko", "dev"), engine.packageName("lite", "release"), engine.packageName("lite", "dev")],
    ["com.zmarn.once", "com.zmarn.once.dev", "com.zmarn.once.lite", "com.zmarn.once.lite.dev"]
  )
  assert.deepEqual(engine.devPackages(), ["com.zmarn.once.dev", "com.zmarn.once.lite.dev"])
})

test("the Gradle engine dimension keeps GeckoView and its assets out of Once Lite", () => {
  const gradle = fs.readFileSync(path.join(app, "build.gradle"), "utf8")
  assert.match(gradle, /flavorDimensions \+= \["engine", "environment"\]/)
  assert.match(gradle, /gecko \{\s*dimension "engine"\s*\}/)
  assert.match(gradle, /lite \{\s*dimension "engine"\s*applicationIdSuffix "\.lite"\s*\}/)
  // The GeckoView dependency is declared for the gecko flavour only.
  assert.match(gradle, /geckoImplementation "org\.mozilla\.geckoview:geckoview:\$geckoViewVersion"/)
  assert.doesNotMatch(gradle, /\n\s*implementation "org\.mozilla\.geckoview/)
  assert.match(gradle, /onVariants\(selector\(\)\.withFlavor\("engine", "gecko"\)\)[\s\S]*addGeneratedSourceDirectory\(onceExtensionAssets/)
  // Once Lite ships the plain upstream bundles under assets/extensions/<dir>/ (no Gecko relay copy).
  assert.match(gradle, /onVariants\(selector\(\)\.withFlavor\("engine", "lite"\)\)[\s\S]*addGeneratedSourceDirectory\(onceLiteExtensionAssets/)
  assert.match(gradle, /it\.include\('ublock-origin\/\*\*', 'violentmonkey\/\*\*'\)/)
  assert.doesNotMatch(gradle, /OnceLiteExtensionAssets[\s\S]*android\/violentmonkey/)
  // Both app names come from the variant, since the environment flavour cannot see the engine.
  assert.match(gradle, /\(lite \? "Once Lite" : "Once"\) \+ \(dev \? " Dev" : ""\)/)
  // minSdk is shared and stays at 26 for Lite.
  assert.match(fs.readFileSync(path.join(root, "apps/mobile/android/variables.gradle"), "utf8"), /minSdkVersion = 26/)
})

test("only the gecko source set imports GeckoView; both engines provide EngineSurface", () => {
  for (const sourceSet of ["main", "lite"]) {
    for (const file of javaFiles(path.join(app, "src", sourceSet, "java"))) {
      assert.doesNotMatch(fs.readFileSync(file, "utf8"), /org\.mozilla/, `${path.relative(app, file)} must not import GeckoView`)
    }
  }
  assert.ok(javaFiles(path.join(app, "src/gecko/java")).some(file => file.endsWith("GeckoEngine.java")))
  for (const sourceSet of ["gecko", "lite"]) {
    const surface = fs.readFileSync(path.join(app, `src/${sourceSet}/java/com/zmarn/once/EngineSurface.java`), "utf8")
    assert.match(surface, /static void register\(MainActivity activity\)/)
    assert.match(surface, /static final boolean ALWAYS_INSPECTABLE = (true|false);/)
  }
  const main = fs.readFileSync(path.join(app, "src/main/java/com/zmarn/once/MainActivity.java"), "utf8")
  assert.match(main, /EngineSurface\.register\(this\)/)
  assert.doesNotMatch(main, /InAppBrowserSurfacePlugin|GeckoEngine/)
  for (const shell of ["WebInspectorPlugin", "ShellRenderRecovery"]) {
    assert.doesNotMatch(fs.readFileSync(path.join(app, `src/main/java/com/zmarn/once/${shell}.java`), "utf8"), /InAppBrowserSurfacePlugin|GeckoEngine/)
  }
})

test("Once Lite registers the shell's plugin names on the system WebView and keeps debugging on", () => {
  const lite = path.join(app, "src/lite/java/com/zmarn/once")
  const surface = fs.readFileSync(path.join(lite, "LiteSurfacePlugin.java"), "utf8")
  assert.match(surface, /@CapacitorPlugin\(name = "InAppBrowserSurface"\)/)
  assert.match(surface, /implements ReadingSurfaceEngine/)
  for (const method of ["open", "navigate", "reload", "goBack", "goForward", "goToHistoryIndex", "capturePreview", "setBounds", "setVisible",
    "showMenu", "closeBrowserMenu", "showContextMenu", "setContextMenuItems", "showPrompt", "evaluateJavaScript", "applyExtensionSettings",
    "findInPage", "clearFind", "presentFind", "close", "selectTab", "extensionCommand", "extensionPage", "clearSiteData", "clearAllData",
    "fetchDocument", "recognizeImage", "imageTextOverlay", "openExternalRedirect"]) {
    assert.match(surface, new RegExp(`public void ${method}\\(PluginCall call\\)`), method)
  }
  assert.match(fs.readFileSync(path.join(lite, "LiteViolentmonkeyPlugin.java"), "utf8"), /@CapacitorPlugin\(name = "GeckoViolentmonkey"\)[\s\S]*"NOT_RUNNING"/)
  const engineSurface = fs.readFileSync(path.join(lite, "EngineSurface.java"), "utf8")
  assert.match(engineSurface, /ALWAYS_INSPECTABLE = true/)
  assert.match(engineSurface, /WebView\.setWebContentsDebuggingEnabled\(true\)/)
  assert.match(fs.readFileSync(path.join(lite, "devtools/DevToolsClient.java"), "utf8"), /webview_devtools_remote_/)
})

test("the Lite runtime's Java half follows the broker protocol", () => {
  const lite = path.join(app, "src/lite/java/com/zmarn/once")
  const engine = fs.readFileSync(path.join(lite, "lite/LiteExtensionEngine.java"), "utf8")
  // lite.start names the bundles by their fetch-extensions ids and asset directories, and tells the broker about DevTools.
  assert.match(engine, /UBLOCK_ID = "uBlock0@raymondhill\.net"/)
  assert.match(engine, /VIOLENTMONKEY_ID = "\{aecec67f-0d10-4fa7-b7c7-609a2db280cf\}"/)
  assert.match(engine, /\{ UBLOCK_ID, "asset:extensions\/ublock-origin" \}, \{ VIOLENTMONKEY_ID, "asset:extensions\/violentmonkey" \}/)
  // The tier is decided at the first start and kept for the process.
  assert.match(engine, /if \(decidedTier2 == null\) decidedTier2 = !devtools\.available\(\)/)
  assert.match(engine, /\.put\("devtools", useDevtools\)/)
  assert.match(engine, /\.put\("channel", channelToken\)/)
  assert.match(engine, /DEVTOOLS_UNAVAILABLE = "Extensions limited: DevTools unavailable"/)
  for (const method of ["ui.confirm", "ui.pickFile", "page.open", "page.close", "page.post", "page.resize", "tab.create", "tab.update", "tab.remove", "tab.reload"]) {
    assert.match(engine, new RegExp(`onRequest\\("${method.replace(".", "\\.")}"`), method)
  }
  for (const event of ["broker.hello", "extensions.changed", "violentmonkey.connected", "violentmonkey.dashboardChanged", "log", "timer.set", "timer.clear"]) {
    assert.match(engine, new RegExp(`onEvent\\("${event.replace(".", "\\.")}"`), event)
  }
  const targets = fs.readFileSync(path.join(lite, "lite/LiteTargets.java"), "utf8")
  // Fetch is enabled per page target at both stages; the bridge world and binding ride every tab target.
  assert.match(targets, /"requestStage", "Request"/)
  assert.match(targets, /"requestStage", "Response"/)
  assert.match(targets, /BRIDGE_BINDING = "onceLiteBridge"/)
  assert.match(targets, /BRIDGE_WORLD = "once-bridge"/)
  assert.match(targets, /onRequest\("worlds\.set"/)
  const files = fs.readFileSync(path.join(lite, "lite/LiteFiles.java"), "utf8")
  assert.match(files, /BUNDLE_DIRECTORY = "@bundle"/)
  assert.match(files, /ASSET_PREFIX = "asset:"/)
  for (const method of ["store.read", "store.write", "files.mkdir", "files.write", "files.remove", "files.list", "package.readArchive"]) {
    assert.match(files, new RegExp(`onRequest\\("${method.replace(".", "\\.")}"`), method)
  }
  assert.match(fs.readFileSync(path.join(lite, "lite/LitePackages.java"), "utf8"), /setInstanceFollowRedirects\(false\)/)
  const page = fs.readFileSync(path.join(lite, "lite/LitePage.java"), "utf8")
  assert.match(page, /Firefox\/128\.0/)
  assert.match(page, /CHANNEL = "onceLitePage"/)
  // The surface plugin relays the shell's contract to the engine and holds pages behind its barriers.
  const surface = fs.readFileSync(path.join(lite, "LiteSurfacePlugin.java"), "utf8")
  assert.match(surface, /extensions\.whenStarted\(READY_TIMEOUT_MS/)
  assert.match(surface, /extensions\.whenSettingsApplied\(/)
  assert.match(surface, /bridge\.evaluate\(script/)
  assert.match(fs.readFileSync(path.join(lite, "LiteViolentmonkeyPlugin.java"), "utf8"), /engine\(\)\.violentmonkey\("send"/)
  // The package step fetches the bundles for both engines.
  assert.doesNotMatch(fs.readFileSync(path.join(root, "apps/mobile/scripts/mobile-cli.js"), "utf8"), /if \(engine === "gecko"\) run\(process\.execPath, \[path\.join\(root, "scripts", "fetch-extensions\.js"\)\]\)/)
})

test("the e2e harness, CI and docs carry the engine", () => {
  const smoke = fs.readFileSync(path.join(root, "tests/e2e/mobile/mobile.smoke.js"), "utf8")
  assert.match(smoke, /packageName\(androidEngine, "dev"\)/)
  assert.match(smoke, /androidEngine === "lite"\)\) await expectExtensionsApplied\(\)/)
  assert.doesNotMatch(smoke, /"com\.zmarn\.once\.dev"/)
  const wdio = fs.readFileSync(path.join(root, "tests/e2e/mobile/wdio.shared.conf.js"), "utf8")
  assert.match(wdio, /packageName\(engine, "dev"\)/)
  const runner = fs.readFileSync(path.join(root, "tests/e2e/mobile/run-mobile-e2e.js"), "utf8")
  assert.match(runner, /stamp\.engine \|\| "gecko"\) !== engine/)
  const scripts = require(path.join(root, "package.json")).scripts
  assert.equal(scripts["test:mobile:e2e:android:lite"], "node tests/e2e/mobile/run-mobile-e2e.js android --engine lite")
  assert.equal(scripts["test:mobile:e2e:android:lite:local"], "node tests/e2e/mobile/run-android-local.js --engine lite")
  for (const name of ["run:mobile:android:lite", "run:mobile:android:lite:emulator", "package:mobile:android:lite", "deploy:mobile:android:lite", "inspect:mobile:android:lite"]) {
    assert.match(scripts[name], /lite/, name)
  }
  const ci = fs.readFileSync(path.join(root, ".github/workflows/mobile.yml"), "utf8")
  assert.match(ci, /mobile-android-lite:/)
  assert.match(ci, /--engine lite/)
  assert.match(ci, /lintLiteDevelopmentDebug testLiteDevelopmentDebugUnitTest/)
  assert.match(ci, /test:mobile:e2e:android:lite/)
  assert.match(fs.readFileSync(path.join(root, ".github/workflows/mobile-compat.yml"), "utf8"), /engine: \[gecko, lite\]/)
  const docs = fs.readFileSync(path.join(root, "docs/DEVELOPMENT.md"), "utf8")
  assert.match(docs, /`com\.zmarn\.once\.lite\.dev` \| Once Lite Dev \| `liteDevelopment`/)
  assert.match(fs.readFileSync(path.join(root, "tests/e2e/mobile/build-extension-benchmark-android.js"), "utf8"), /src\/gecko\/java\/com\/zmarn\/once\/GeckoEngine\.java/)
})
