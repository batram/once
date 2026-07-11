const { spawnSync } = require("child_process")
const path = require("path")

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

const args = process.argv.slice(2).filter((arg) => arg !== "--dev")
const defaultChannel =
  process.argv.includes("--dev") || args[0] === "start" ? "dev" : "release"

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
