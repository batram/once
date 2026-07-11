const { version } = require("../package.json")
const fs = require("fs")
const path = require("path")

const ref = process.env.GITHUB_REF_NAME || process.argv[2]

if (!ref) {
  throw new Error("Pass a release tag (for example v1.2.3) or set GITHUB_REF_NAME")
}

if (ref !== `v${version}`) {
  throw new Error(`Release tag ${ref} does not match package version v${version}`)
}

const notesPath = path.resolve(__dirname, `../.github/release-notes/${ref}.md`)
if (!fs.existsSync(notesPath)) {
  throw new Error(`Missing release notes: ${notesPath}`)
}

const notes = fs.readFileSync(notesPath, "utf8")
for (const product of ["electron", "chrome-extension", "firefox-extension"]) {
  const productPackage = require(`../apps/${product}/package.json`)
  if (productPackage.version !== version) {
    throw new Error(`${product} package version ${productPackage.version} does not match ${version}`)
  }
}

for (const product of ["Electron", "Chrome", "Firefox"]) {
  const status = new RegExp(`^- ${product}: (Changed|Unchanged)(?: — .+)?$`, "m")
  if (!status.test(notes)) {
    throw new Error(`Release notes must mark ${product} as Changed or Unchanged`)
  }
}

console.log(`Release version verified: ${ref}`)
