const path = require("node:path")
const { defineConfig } = require("@playwright/test")

module.exports = defineConfig({
  testDir: __dirname,
  testMatch: "story-list.debug.js",
  outputDir: path.resolve(
    __dirname,
    "../../../test-results/electron-story-debug"
  ),
  timeout: 90_000,
  expect: {
    timeout: 5_000
  },
  use: {
    trace: "on"
  },
  actionTimeout: 5_000,
  retries: 0,
  workers: 1,
  reporter: [
    ["line"],
    [
      "html",
      {
        open: "never",
        outputFolder: path.resolve(
          __dirname,
          "../../../playwright-report/electron-story-debug"
        )
      }
    ]
  ]
})
