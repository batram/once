const path = require("path")
const { defineConfig, devices } = require("@playwright/test")

module.exports = defineConfig({
  testDir: __dirname,
  testMatch: "mobile-web.spec.js",
  globalSetup: path.join(__dirname, "global-setup.js"),
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:3211/app/",
    ...devices["Pixel 7"]
  }
})
