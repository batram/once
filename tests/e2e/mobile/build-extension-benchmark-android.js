const fs = require("node:fs")
const path = require("node:path")
const { execFileSync } = require("node:child_process")
const root = path.resolve(__dirname, "../../..")
const out = path.resolve(process.argv[2] || "/tmp/once-extension-benchmark-android")
const java = path.join(out, "app/src/main/java/com/zmarn/once")
fs.mkdirSync(java, { recursive: true })
let bridgeAssets = path.join(root, "apps/mobile/extensions")
const reference = process.env.ONCE_BENCH_BRIDGE_REVISION
if (reference) {
  bridgeAssets = path.join(out, "reference-assets")
  const files = execFileSync("git", ["ls-tree", "-r", "--name-only", reference, "apps/mobile/extensions"], { cwd: root, encoding: "utf8" }).trim().split("\n")
  if (!files[0]) throw new Error("Reference contains no mobile extension assets")
  for (const file of files) {
    const destination = path.join(bridgeAssets, path.relative("apps/mobile/extensions", file))
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.writeFileSync(destination, execFileSync("git", ["show", `${reference}:${file}`], { cwd: root }))
  }
}
fs.copyFileSync(path.join(__dirname, "ExtensionBenchmarkActivity.java"), path.join(java, "ExtensionBenchmarkActivity.java"))
let engine = fs.readFileSync(path.join(root, "apps/mobile/android/app/src/main/java/com/zmarn/once/GeckoEngine.java"), "utf8")
// Controlled ablations only: separate persistent profile per mode and selected bundles.
engine = engine.replace(".remoteDebuggingEnabled", '.arguments(new String[] { "-profile", new java.io.File(context.getFilesDir(), "profile-" + System.getProperty("once.benchmark.mode")).getAbsolutePath() })\n            .remoteDebuggingEnabled')
engine = engine.replace("for (String[] bundle : bundles) {", `for (String[] bundle : bundles) {
            String mode = System.getProperty("once.benchmark.mode");
            if (mode.equals("bare")) continue;
            if (!bundle[0].equals("once-surface") && !mode.equals("all") &&
                !(mode.equals("blocker") && bundle[0].equals("ublock-origin")) &&
                !(mode.equals("vm") && bundle[0].equals("violentmonkey"))) continue;`)
fs.writeFileSync(path.join(java, "GeckoEngine.java"), engine)
fs.writeFileSync(path.join(out, "settings.gradle"), "pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }\ndependencyResolutionManagement { repositories { google(); mavenCentral(); maven { url 'https://maven.mozilla.org/maven2/' } } }\nrootProject.name='ExtensionBenchmark'\ninclude ':app'\n")
fs.writeFileSync(path.join(out, "build.gradle"), "buildscript { repositories { google(); mavenCentral() }; dependencies { classpath 'com.android.tools.build:gradle:9.4.0' } }\n")
fs.writeFileSync(path.join(out, "gradle.properties"), "android.useAndroidX=true\norg.gradle.jvmargs=-Xmx2048m\n")
fs.writeFileSync(path.join(out, "app/build.gradle"), `apply plugin: 'com.android.application'
android { namespace='com.zmarn.once'; compileSdk=37; compileSdkMinor=1
 defaultConfig { applicationId='com.zmarn.once.extensionbenchmark'; minSdk=26; targetSdk=36; versionCode=1; versionName='1.0'; ndk { abiFilters 'arm64-v8a' }; aaptOptions { ignoreAssetsPattern='!.svn:!.git:!.ds_store:!*.scc:.*:!CVS:!thumbs.db:!picasa.ini:!*~' } }
 sourceSets { main { assets.srcDirs += ['${bridgeAssets}','${root}/vendor/extensions']; assets.exclude 'ublock-origin-lite/**','ios/**' } }
}
dependencies { implementation 'org.mozilla.geckoview:geckoview:155.0.20260903215306' }
`)
fs.writeFileSync(path.join(out, "app/src/main/AndroidManifest.xml"), "<manifest xmlns:android=\"http://schemas.android.com/apk/res/android\"><uses-permission android:name=\"android.permission.INTERNET\"/><application android:label=\"Once Extension Benchmark\" android:usesCleartextTraffic=\"true\" android:theme=\"@android:style/Theme.Material.Light.NoActionBar\"><activity android:name=\".ExtensionBenchmarkActivity\" android:exported=\"true\"><intent-filter><action android:name=\"android.intent.action.MAIN\"/><category android:name=\"android.intent.category.LAUNCHER\"/></intent-filter></activity></application></manifest>")
console.log(out)
