// Removes build artifacts. By default cleans every output the repo
// produces; pass --packages to clean only packages/*/dist.
const fs = require("fs")
const path = require("path")

const root = path.resolve(__dirname, "..")
const packagesRoot = path.join(root, "packages")
const packagesOnly = process.argv.includes("--packages")

const targets = []

for (const entry of fs.readdirSync(packagesRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  targets.push(path.join(packagesRoot, entry.name, "dist"))
}

if (!packagesOnly) {
  targets.push(
    path.join(root, "apps", "chrome-extension", "dist"),
    path.join(root, "apps", "firefox-extension", "dist"),
    path.join(root, "apps", "electron", ".webpack"),
    path.join(root, "apps", "electron", "out"),
    path.join(root, "apps", "mobile", "dist"),
    path.join(root, "apps", "mobile", "android", ".gradle"),
    path.join(root, "apps", "mobile", "android", "build"),
    path.join(root, "apps", "mobile", "android", "app", "build"),
    path.join(root, "apps", "mobile", "android", "app", "src", "main", "assets", "public"),
    path.join(root, "apps", "mobile", "android", "app", "src", "main", "assets", "capacitor.config.json"),
    path.join(root, "apps", "mobile", "android", "app", "src", "main", "assets", "capacitor.plugins.json"),
    path.join(root, "apps", "mobile", "android", "app", "src", "main", "res", "xml", "config.xml"),
    path.join(root, "apps", "mobile", "android", "capacitor-cordova-android-plugins"),
    path.join(root, "apps", "mobile", "ios", "build"),
    path.join(root, "apps", "mobile", "ios", "DerivedData"),
    path.join(root, "apps", "mobile", "ios", "App", "build"),
    path.join(root, "apps", "mobile", "ios", "App", "output"),
    path.join(root, "apps", "mobile", "ios", "App", "App", "public"),
    path.join(root, "apps", "mobile", "ios", "App", "App", "capacitor.config.json"),
    path.join(root, "apps", "mobile", "ios", "App", "App", "config.xml"),
    path.join(root, "apps", "mobile", "ios", "capacitor-cordova-ios-plugins"),
    path.join(root, "web-ext-artifacts"),
    path.join(root, "test-results"),
    path.join(root, "playwright-report")
  )
}

for (const target of targets) {
  const resolved = path.resolve(target)
  if (!resolved.startsWith(root + path.sep)) {
    throw new Error(`Refusing to clean output outside ${root}`)
  }
  if (fs.existsSync(resolved)) {
    fs.rmSync(resolved, { recursive: true, force: true })
    console.log(`removed ${path.relative(root, resolved)}`)
  }
}
