const { copyFile, mkdir } = require("node:fs/promises")
const path = require("node:path")

const root = path.resolve(__dirname, "..")
const source = path.join(root, "packages", "ui-web", "src", "reader")
const destination = path.join(root, "packages", "ui-web", "dist", "reader")
const assets = ["readerDocument.html", "readerDocument.css"]

async function copyPackageAssets() {
  await mkdir(destination, { recursive: true })
  await Promise.all(assets.map((asset) =>
    copyFile(path.join(source, asset), path.join(destination, asset))
  ))
}

copyPackageAssets().catch((error) => {
  console.error("Unable to copy package assets", error)
  process.exitCode = 1
})
