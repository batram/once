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
    // Pin the simulator runtime only when explicitly requested. The macos-26
    // runner ships varying iOS point releases (26.2/26.4/26.5), so let XCUITest
    // pick a runtime matching the device name unless overridden.
    if (process.env.ONCE_IOS_VERSION) {
      common["appium:platformVersion"] = process.env.ONCE_IOS_VERSION
    }
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
