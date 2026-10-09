// Run a Node-based GUI test command and all its descendants on a private desktop.
const { spawnSync } = require("node:child_process")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const args = process.argv.slice(2)
if (args[0] === "--child") {
  const command = JSON.parse(fs.readFileSync(args[1], "utf8"))
  const output = fs.openSync(command.log, "w")
  const child = spawnSync(command.executable, command.args, {
    cwd: command.cwd, stdio: ["ignore", output, output]
  })
  if (child.error) fs.writeSync(output, `${child.error.stack}\n`)
  fs.closeSync(output)
  process.exit(child.status ?? 1)
}
const visible = args[0] === "--visible"
if (visible) args.shift()
if (!args.length) throw new Error("Usage: node scripts/run-hidden.js [--visible] <script> [arguments]")
let result
if (process.platform !== "win32" || process.env.CI || visible) {
  result = spawnSync(process.execPath, args, { stdio: "inherit" })
} else {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "once-hidden-test-"))
  const manifest = path.join(directory, "command.json")
  const log = path.resolve("artifacts/hidden-tests", `${Date.now()}-${process.pid}.log`)
  fs.mkdirSync(path.dirname(log), { recursive: true })
  fs.writeFileSync(manifest, JSON.stringify({ executable: process.execPath, args, cwd: process.cwd(), log, runner: __filename }))
  try {
    result = spawnSync("powershell.exe", ["-NoProfile", "-File", path.join(__dirname, "run-hidden.ps1"), "-Manifest", manifest], {
      stdio: "inherit", windowsHide: true
    })
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}
if (result.error) console.error(result.error)
process.exit(result.status ?? 1)
