/* global browser */

const path = require("path")

function configFor(platform) {
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
    "appium:fullReset": true,
    "appium:newCommandTimeout": 120
  }
  if (platform === "android") {
    common["appium:deviceName"] = process.env.ONCE_MOBILE_DEVICE || "Once API 36"
    common["appium:appPackage"] = "com.zmarn.once.dev"
    common["appium:appActivity"] = "com.zmarn.once.MainActivity"
    common["appium:chromedriverAutodownload"] = true
  } else {
    common["appium:deviceName"] = process.env.ONCE_MOBILE_DEVICE || "iPhone 17 Pro"
    common["appium:platformVersion"] = process.env.ONCE_IOS_VERSION || "26.0"
    // iOS 18 exposes Capacitor's inspectable page under the display-name process
    // while also advertising a generic WebKit process with no pages. Target the
    // app process so Appium does not retry the empty generic process until timeout.
    common["appium:additionalWebviewBundleIds"] = ["process-Once Dev"]
    common["appium:ignoredWebviewBundleIds"] = ["process-com.apple.WebKit.WebContent"]
    if (process.env.ONCE_IOS_UDID) common["appium:udid"] = process.env.ONCE_IOS_UDID
  }
  return {
    runner: "local",
    specs: [path.join(__dirname, "mobile.smoke.js")],
    maxInstances: 1,
    logLevel: "info",
    outputDir: results,
    framework: "mocha",
    reporters: ["spec"],
    mochaOpts: { timeout: 120_000 },
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
