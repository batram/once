const fs = require("fs")
const path = require("path")
const rootPackage = require("../package.json")

const products = ["electron", "chrome-extension", "firefox-extension", "mobile"]

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

for (const product of products) {
  const packagePath = path.resolve(__dirname, `../apps/${product}/package.json`)
  const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"))
  packageJson.version = rootPackage.version
  writeJson(packagePath, packageJson)
}

const lockPath = path.resolve(__dirname, "../package-lock.json")
const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"))
for (const product of products) {
  lock.packages[`apps/${product}`].version = rootPackage.version
}
writeJson(lockPath, lock)

const mobileProjectPath = path.resolve(
  __dirname,
  "../apps/mobile/ios/App/App.xcodeproj/project.pbxproj"
)
if (fs.existsSync(mobileProjectPath)) {
  const project = fs.readFileSync(mobileProjectPath, "utf8")
  fs.writeFileSync(
    mobileProjectPath,
    project.replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${rootPackage.version};`)
  )
}

console.log(`Synchronized product versions to ${rootPackage.version}`)
