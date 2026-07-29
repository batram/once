const path = require("path")
const { defineConfig, devices } = require("@playwright/test")
const port = Number.parseInt(process.env.ONCE_MOBILE_TEST_PORT || "3211", 10)

module.exports = defineConfig({
  testDir: __dirname,
  testMatch: "mobile-web.spec.js",
  globalSetup: path.join(__dirname, "global-setup.js"),
  timeout: 30_000,
  use: {
    baseURL: `http://127.0.0.1:${port}/app/`,
    ...devices["Pixel 7"]
  }
})
