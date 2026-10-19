// The Android app's two engines (docs/plans/once-lite-plan.md): GeckoView, and
// Once Lite on the system WebView. Gradle's flavour dimensions are engine, then
// environment, so every task, artifact path and package id derives from the
// pair here, for the CLI, the e2e runners and the tests alike.

const ENGINES = ["gecko", "lite"]

function mobileEngine(value = process.env.ONCE_MOBILE_ENGINE) {
  if (!value) return "gecko"
  if (!ENGINES.includes(value)) throw new Error(`engine must be gecko or lite (received ${value})`)
  return value
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

/** The flavour name Gradle uses in task and path names: geckoDevelopment, liteProduction... */
function flavorName(engine, channel) {
  return `${mobileEngine(engine)}${channel === "release" ? "Production" : "Development"}`
}

/** assemble<Flavor>Debug or bundle<Flavor>Release, as the CLI's package and deploy build. */
function gradleTask(engine, channel, kind = "assemble") {
  const flavor = capitalize(flavorName(engine, channel))
  if (kind === "bundle") return `bundle${flavor}Release`
  return `assemble${flavor}Debug`
}

/** The debug APK Gradle writes, relative to apps/mobile. */
function apkPath(engine, channel) {
  const flavor = flavorName(engine, channel)
  const dashed = `${mobileEngine(engine)}-${channel === "release" ? "production" : "development"}`
  return `android/app/build/outputs/apk/${flavor}/debug/app-${dashed}-debug.apk`
}

/** com.zmarn.once[.lite][.dev]. */
function packageName(engine, channel) {
  return `com.zmarn.once${mobileEngine(engine) === "lite" ? ".lite" : ""}${channel === "release" ? "" : ".dev"}`
}

/** Every dev package an e2e cleanup may remove from an emulator. */
function devPackages() {
  return ENGINES.map(engine => packageName(engine, "dev"))
}

module.exports = { ENGINES, mobileEngine, flavorName, gradleTask, apkPath, packageName, devPackages }
