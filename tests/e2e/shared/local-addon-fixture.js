const { ZipWriter, BlobWriter, TextReader } = require("@zip.js/zip.js")

function files(text = "Local package ready") {
  return {
    "once-addon.json": JSON.stringify({ protocol: 1, id: "local-package", name: "Local package", version: "1.0.0", script: "main.js",
      contributions: [{ kind: "badge", id: "ready", compute: "ready" }] }),
    "main.js": `export default function activate(once) { once.onBadges((_id, stories) => stories.map(() => ${JSON.stringify(text)})); }`
  }
}

async function zipFile() {
  const writer = new ZipWriter(new BlobWriter(), { useWebWorkers: false })
  for (const [name, text] of Object.entries(files())) await writer.add(`local-package/${name}`, new TextReader(text))
  return Buffer.from(await (await writer.close()).arrayBuffer())
}

async function importZip(page) {
  await require("./addon-settings-ui").addonImport(page)
  const chooser = page.waitForEvent("filechooser")
  await page.getByTestId("import-addon-zip").click()
  await (await chooser).setFiles({ name: "local-package.zip", mimeType: "application/zip", buffer: await zipFile() })
  await page.getByTestId("confirm-addon").click()
}

module.exports = { files, zipFile, importZip }
