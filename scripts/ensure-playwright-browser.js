const fs = require("fs")
const path = require("path")
const { spawnSync } = require("child_process")
const { chromium } = require("playwright")

const executable = chromium.executablePath()
const accessMode = process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK

try {
  fs.accessSync(executable, accessMode)
  console.log(`Playwright Chromium is available: ${executable}`)
  process.exit(0)
} catch {
  console.log("Playwright Chromium is missing; installing it for this Playwright version.")
}

const playwrightCli = path.join(
  path.dirname(require.resolve("playwright")),
  "cli.js"
)
const result = spawnSync(
  process.execPath,
  [playwrightCli, "install", "chromium"],
  { stdio: "inherit" }
)

if (result.error) throw result.error
if (result.signal) {
  console.error(`Playwright browser installation stopped by ${result.signal}`)
  process.exit(1)
}
process.exit(result.status ?? 1)
