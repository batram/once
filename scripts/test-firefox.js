const { spawnSync } = require("node:child_process")
const path = require("node:path")

const tests = ["firefox", "firefox-stories", "firefox-addons", "geny-firefox"]
  .map((name) => `tests/e2e/extensions/${name}.test.js`)
const result = process.platform === "win32"
  ? spawnSync("powershell.exe", ["-NoProfile", "-File", path.join(__dirname, "test-firefox-hidden.ps1")], { stdio: "inherit" })
  : spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...tests], { stdio: "inherit" })
if (result.error) console.error(result.error)
process.exit(result.status ?? 1)
