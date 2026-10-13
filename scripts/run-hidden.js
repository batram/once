// Run a Node-based GUI test command and all its descendants on a private desktop.
const { spawn, spawnSync } = require("node:child_process")
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
if (process.platform !== "win32" || process.env.CI || visible) {
  const result = spawnSync(process.execPath, args, { stdio: "inherit" })
  if (result.error) console.error(result.error)
  process.exit(result.status ?? 1)
} else {
  runHidden()
}

function runHidden() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "once-hidden-test-"))
  const manifest = path.join(directory, "command.json")
  const log = path.resolve("artifacts/hidden-tests", `${Date.now()}-${process.pid}.log`)
  fs.mkdirSync(path.dirname(log), { recursive: true })
  fs.writeFileSync(log, "")
  fs.writeFileSync(manifest, JSON.stringify({ executable: process.execPath, args, cwd: process.cwd(), log, runner: __filename }))
  console.log(`Running tests on the hidden desktop; output: ${log}`)
  const launcher = spawn("powershell.exe", ["-NoProfile", "-File", path.join(__dirname, "run-hidden.ps1"), "-Manifest", manifest], {
    stdio: "inherit", windowsHide: true,
    // The hidden desktop's child inherits this; harnesses adapt to it (no GPU there).
    env: { ...process.env, ONCE_HIDDEN_DESKTOP: "1" }
  })
  // The run's own console is on the hidden desktop: show its log as it grows,
  // so a long run is visibly progressing rather than indistinguishable from a hang.
  let shown = 0
  const follow = () => {
    const size = fs.statSync(log).size
    if (size <= shown) return
    const chunk = Buffer.alloc(size - shown)
    const fd = fs.openSync(log, "r")
    try { fs.readSync(fd, chunk, 0, chunk.length, shown) } finally { fs.closeSync(fd) }
    shown = size
    process.stdout.write(chunk)
  }
  const timer = setInterval(follow, 1000)
  launcher.on("error", (error) => console.error(error))
  launcher.on("close", (status) => {
    clearInterval(timer)
    follow()
    fs.rmSync(directory, { recursive: true, force: true })
    // No status means the launcher was killed: never report that as a pass.
    process.exit(status ?? 1)
  })
}
