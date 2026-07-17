const { spawnSync } = require("child_process")
const path = require("path")
const {
  packagedAppTarget,
  shouldSkipPackagedAppStop,
  shouldStopPackagedApp,
  stopPackagedApp
} = require("./stop-packaged-app")

const repositoryRoot = path.resolve(__dirname, "../../..")
const nodeBinary = path.join(
  repositoryRoot,
  "node_modules",
  "node",
  "bin",
  process.platform === "win32" ? "node.exe" : "node"
)
const forgeCli = path.join(
  repositoryRoot,
  "node_modules",
  "@electron-forge",
  "cli",
  "dist",
  "electron-forge.js"
)

const rawArgs = process.argv.slice(2)
const skipPackagedAppStop = shouldSkipPackagedAppStop(rawArgs, process.env)
const args = rawArgs.filter((arg) => !["--dev", "--nokill"].includes(arg))
const defaultChannel =
  rawArgs.includes("--dev") || args[0] === "start" ? "dev" : "release"

if (shouldStopPackagedApp(process.platform, args[0], skipPackagedAppStop)) {
  const target = packagedAppTarget(
    path.resolve(__dirname, "../out"),
    defaultChannel
  )
  stopPackagedApp(target.outputRoot, target.processName)
} else if (
  process.platform === "win32" &&
  ["package", "make"].includes(args[0]) &&
  skipPackagedAppStop
) {
  console.log("Skipping packaged Once app termination (--nokill).")
}

const result = spawnSync(nodeBinary, [forgeCli, ...args], {
  cwd: path.resolve(__dirname, ".."),
  env: {
    ...process.env,
    ONCE_BUILD_CHANNEL: process.env.ONCE_BUILD_CHANNEL || defaultChannel
  },
  stdio: "inherit"
})

if (result.error) throw result.error
process.exitCode = result.status === null ? 1 : result.status
