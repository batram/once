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

const result = spawnSync(nodeBinary, [forgeCli, ...process.argv.slice(2)], {
  cwd: path.resolve(__dirname, ".."),
  env: process.env,
  stdio: "inherit",
})

if (result.error) throw result.error
process.exitCode = result.status === null ? 1 : result.status
