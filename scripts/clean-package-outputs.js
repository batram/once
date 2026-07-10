const fs = require("fs")
const path = require("path")

const root = path.resolve(__dirname, "..")
const packagesRoot = path.join(root, "packages")

for (const entry of fs.readdirSync(packagesRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue

  const packageRoot = path.resolve(packagesRoot, entry.name)
  const outputPath = path.resolve(packageRoot, "dist")

  if (path.dirname(outputPath) !== packageRoot) {
    throw new Error(`Refusing to clean output outside ${packageRoot}`)
  }

  fs.rmSync(outputPath, { recursive: true, force: true })
}
