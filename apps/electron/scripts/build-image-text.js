const { spawnSync } = require("node:child_process")
const fs = require("node:fs")
const path = require("node:path")

// A universal helper works in both Intel and Apple Silicon application bundles.
function buildImageText() {
  if (process.platform !== "darwin") return
  const directory = path.resolve(__dirname, "../.native")
  const source = path.resolve(__dirname, "../native/ImageText.swift")
  const output = path.join(directory, "once-image-text")
  if (fs.existsSync(output) && fs.statSync(output).mtimeMs >= fs.statSync(source).mtimeMs) return
  fs.mkdirSync(directory, { recursive: true })
  const run = (command, args) => {
    const result = spawnSync(command, args, { stdio: "inherit" })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`Image text helper build failed: ${command}`)
  }
  for (const arch of ["arm64", "x86_64"]) {
    run("xcrun", ["swiftc", "-O", "-target", `${arch}-apple-macosx12.0`,
      "-module-cache-path", path.join(directory, "module-cache"), source, "-o", `${output}-${arch}`])
  }
  run("xcrun", ["lipo", "-create", `${output}-arm64`, `${output}-x86_64`, "-output", output])
  run("codesign", ["--force", "--sign", "-", output])
}

module.exports = { buildImageText }
if (require.main === module) buildImageText()
