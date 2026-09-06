/* global browser */

const path = require("path")

function configFor(platform) {
  const visual = process.env.ONCE_MOBILE_VISUAL_INSPECTION === "1"
  const root = path.resolve(__dirname, "../../..")
  const androidApp = path.join(
    root,
    "apps/mobile/android/app/build/outputs/apk/development/debug/app-development-debug.apk"
  )
  const iosApp = path.join(
    root,
    "apps/mobile/ios/build/Build/Products/Debug-iphonesimulator/Once Dev.app"
  )
  const results = path.join(root, "test-results", "mobile")
  const common = {
    platformName: platform === "android" ? "Android" : "iOS",
    "appium:app": process.env.ONCE_MOBILE_APP || (platform === "android" ? androidApp : iosApp),
    "appium:automationName": platform === "android" ? "UiAutomator2" : "XCUITest",
    // Android reinstalls the APK cheaply. On iOS, fullReset shuts down and
    // *erases* the simulator before the session, which discards the runner
    // pre-boot and forces a fresh-erase reboot that hangs on "Waiting on
    // BackBoard". Test data isolation comes from the mobile test server's
    // per-run database reset, not from wiping the simulator, so iOS reuses the
    // already-booted device and just reinstalls the app (the default reset).
    "appium:fullReset": platform === "android",
    "appium:newCommandTimeout": 120
  }
  if (visual) {
    common["appium:fullReset"] = false
    common["appium:noReset"] = true
    if (platform === "android") {
      common["appium:dontStopAppOnReset"] = true
    } else {
      common["appium:shouldTerminateApp"] = false
    }
  }
  if (platform === "android") {
    common["appium:deviceName"] = process.env.ONCE_MOBILE_DEVICE || "Once API 36"
    const udid = process.env.ONCE_ANDROID_UDID || process.env.ANDROID_SERIAL
    if (udid) common["appium:udid"] = udid
    common["appium:appPackage"] = "com.zmarn.once.dev"
    common["appium:appActivity"] = "com.zmarn.once.MainActivity"
    common["appium:chromedriverAutodownload"] = true
  } else {
    common["appium:deviceName"] = process.env.ONCE_MOBILE_DEVICE || "iPhone 17 Pro"
    // Pin the simulator runtime only when explicitly requested. The macos-26
    // runner ships varying iOS point releases (26.2/26.4/26.5), so let XCUITest
    // pick a runtime matching the device name unless overridden.
    if (process.env.ONCE_IOS_VERSION) {
      common["appium:platformVersion"] = process.env.ONCE_IOS_VERSION
    }
    // iOS 18 exposes Capacitor's inspectable page under the display-name process
    // while also advertising a generic WebKit process with no pages. Target the
    // app process so Appium does not retry the empty generic process until timeout.
    common["appium:additionalWebviewBundleIds"] = ["process-Once Dev"]
    common["appium:ignoredWebviewBundleIds"] = ["process-com.apple.WebKit.WebContent"]
    if (process.env.ONCE_IOS_UDID) common["appium:udid"] = process.env.ONCE_IOS_UDID
    // On a cold CI runner the first session builds WebDriverAgent from source
    // (the slowest part of XCUITest startup) and boots the simulator, which
    // easily exceeds the WDA-side defaults. Give it room.
    common["appium:wdaLaunchTimeout"] = 240_000
    common["appium:wdaStartupRetries"] = 2
    common["appium:wdaStartupRetryInterval"] = 20_000
    if (process.env.CI) {
      // Surface WDA's xcodebuild output in the Appium log; otherwise a WDA
      // build/launch problem is just silent ECONNREFUSED polling.
      common["appium:showXcodeLog"] = true
      // CI boots the simulator headless via simctl before the session. Without
      // isHeadless, XCUITest sees a booted device with no visible UI and
      // *restarts* it through Simulator.app, then trips its hard-capped 120s
      // boot monitor on runners where boot takes minutes. Accept the headless
      // device as-is, and give any boot the driver still performs more room.
      common["appium:isHeadless"] = true
      common["appium:simulatorStartupTimeout"] = 600_000
    }
  }
  // Session creation on iOS (WDA build + simulator boot) routinely overruns the
  // default 120s client timeout. Raise it to 5min, but stay under the ~6min
  // point where WebdriverIO hits UND_ERR_HEADERS_TIMEOUT (webdriverio#13778).
  // connectionRetryCount is capped so a genuine failure doesn't retry the whole
  // slow handshake several times. Android sessions are fast; leave its defaults.
  const iosTimeouts = platform === "ios"
    ? { connectionRetryTimeout: 300_000, connectionRetryCount: 1 }
    : {}
  return {
    ...iosTimeouts,
    runner: "local",
    specs: [path.join(
      __dirname,
      visual ? "mobile.visual-inspection.js" : process.env.ONCE_MOBILE_ADDONS_ONLY === "1" ? "mobile.addons.js" : "mobile.smoke.js"
    )],
    maxInstances: 1,
    logLevel: "info",
    outputDir: results,
    framework: "mocha",
    reporters: ["spec"],
    // The smoke phases share one device session and each builds on the state
    // the last one left, so stop at the first failure rather than reporting
    // every later phase as broken too.
    mochaOpts: { timeout: 120_000, bail: true },
    services: [["appium", {
      command: "appium",
      logPath: path.join(results, `${platform}-appium.log`),
      args: { relaxedSecurity: true }
    }]],
    capabilities: [common],
    afterTest: async function (_test, _context, result) {
      if (!result.passed) {
        await browser.saveScreenshot(path.join(results, `${platform}-failure.png`))
      }
    }
  }
}

module.exports = { configFor }
