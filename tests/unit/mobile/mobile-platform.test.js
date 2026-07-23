const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")
const { parseHTML } = require("linkedom")
const ts = require("typescript")

function installDom() {
  const { window } = parseHTML("<html><body></body></html>")
  const values = new Map()
  window.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key)
  }
  window.matchMedia = () => ({ matches: false, addEventListener() {} })
  window.fetch = global.fetch
  global.window = window
  global.document = window.document
  global.self = window
  global.addEventListener = () => undefined
  global.removeEventListener = () => undefined
}

test("mobile adapter delegates secure settings, links, and theme through its bridge", async () => {
  installDom()
  const opened = []
  const themes = []
  let syncUrl = ""
  const bridge = {
    getSyncUrl: async () => syncUrl,
    setSyncUrl: async (value) => { syncUrl = value },
    openExternal: async (url) => opened.push(url),
    setSystemTheme: async (theme) => themes.push(theme)
  }
  const { createMobilePlatform } = require("../../../packages/platform-mobile/dist")
  const database = {
    changes: () => ({ on() { return this }, cancel() {} }),
    replicate: { from: () => ({ on() { return this } }) },
    sync: () => ({ on() { return this } })
  }
  const ports = createMobilePlatform(bridge, database)
  await ports.syncSettingsStore.setSyncUrl("https://user:secret@example.test/once")
  assert.equal(await ports.syncSettingsStore.getSyncUrl(), "https://user:secret@example.test/once")
  ports.activeTab.openUrl("javascript:alert(1)", "_self")
  ports.activeTab.openUrl("https://example.test/story", "_self")
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(opened, ["https://example.test/story"])
  ports.theme.setTheme("dark")
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(document.body.getAttribute("data-theme"), "dark")
  assert.deepEqual(themes, ["dark"])
})

test("native secure settings implementations use Keychain and Android Keystore", () => {
  const root = path.resolve(__dirname, "../../..")
  const android = fs.readFileSync(path.join(root, "apps/mobile/android/app/src/main/java/com/zmarn/once/SecureSettingsPlugin.java"), "utf8")
  const ios = fs.readFileSync(path.join(root, "apps/mobile/ios/App/App/AppDelegate.swift"), "utf8")
  assert.match(android, /AndroidKeyStore/)
  assert.match(android, /AES\/GCM\/NoPadding/)
  assert.match(ios, /kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly/)
  assert.match(ios, /SecItemAdd/)
})

test("mobile build channels select stable names, identifiers, schemes, and flavors", () => {
  const root = path.resolve(__dirname, "../../..")
  const source = fs.readFileSync(path.resolve(__dirname, "../../../apps/mobile/capacitor.config.ts"), "utf8")
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const compiledModule = { exports: {} }
  Function("exports", "module", "require", "process", compiled)(
    compiledModule.exports, compiledModule, require, process
  )
  const { createCapacitorConfig, mobileBuildChannel } = compiledModule.exports
  const dev = createCapacitorConfig("dev")
  const release = createCapacitorConfig("release")

  assert.deepEqual([dev.appId, dev.appName, dev.android.flavor, dev.ios.scheme], [
    "com.zmarn.once.dev", "Once Dev", "development", "Once Dev"
  ])
  assert.deepEqual([release.appId, release.appName, release.android.flavor, release.ios.scheme], [
    "com.zmarn.once", "Once", "production", "Once"
  ])
  assert.equal(dev.plugins.CapacitorHttp.enabled, true)
  assert.equal(dev.android.allowMixedContent, true)
  assert.equal(release.android.allowMixedContent, false)
  assert.throws(() => mobileBuildChannel("preview"), /must be dev or release/)

  const androidDevManifest = fs.readFileSync(
    path.join(root, "apps/mobile/android/app/src/development/AndroidManifest.xml"),
    "utf8"
  )
  assert.match(androidDevManifest, /android:icon="@mipmap\/ic_launcher_dev"/)
  assert.match(androidDevManifest, /android:roundIcon="@mipmap\/ic_launcher_dev"/)
  assert.match(androidDevManifest, /tools:replace="android:icon,android:roundIcon"/)
  assert.ok(fs.existsSync(path.join(
    root,
    "apps/mobile/android/app/src/development/res/mipmap-mdpi/ic_launcher_dev.png"
  )))
})

test("mobile release package commands select production native artifacts", () => {
  const root = path.resolve(__dirname, "../../..")
  const rootPackage = require(path.join(root, "package.json"))
  const mobileCli = fs.readFileSync(path.join(root, "apps/mobile/scripts/mobile-cli.js"), "utf8")

  assert.equal(
    rootPackage.scripts["package:mobile:android"],
    "npm run mobile -- package android --channel release"
  )
  assert.equal(
    rootPackage.scripts["package:mobile:ios"],
    "npm run mobile -- package ios --channel release"
  )
  assert.match(mobileCli, /"bundleProductionRelease"/)
  assert.match(mobileCli, /"-scheme", release \? "Once" : "Once Dev"/)
  assert.match(mobileCli, /"-destination", "generic\/platform=iOS"/)
  assert.match(mobileCli, /"CODE_SIGNING_ALLOWED=NO", "archive"/)
})
