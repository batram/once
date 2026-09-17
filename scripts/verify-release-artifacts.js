const fs = require("fs")
const path = require("path")
const { version } = require("../package.json")

const target = process.argv[2]
const root = path.resolve(process.argv[3] || ".")

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name)
    return entry.isDirectory() ? walk(entryPath) : [entryPath]
  })
}

function requireFiles(files, description, predicate) {
  if (!files.some(predicate)) {
    throw new Error(`Missing ${description} for v${version} below ${root}`)
  }
}

function hasBasename(expected) {
  return (file) => path.basename(file) === expected
}

if (!fs.existsSync(root)) {
  throw new Error(`Artifact directory does not exist: ${root}`)
}

if (target === "extensions") {
  for (const browser of ["firefox", "chrome"]) {
    const manifestPath = path.join(root, `apps/${browser}-extension/dist/release/manifest.json`)
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
    if (manifest.version !== version) {
      throw new Error(`${browser} manifest version ${manifest.version} does not match ${version}`)
    }
  }
} else if (target === "electron") {
  const files = walk(root)
  requireFiles(files, "Electron setup executable", (file) => file.endsWith(`-${version} Setup.exe`))
  requireFiles(files, "Electron full NuGet package", (file) => file.endsWith(`-${version}-full.nupkg`))
  requireFiles(files, "Windows Electron ZIP", hasBasename(`Once-win32-x64-${version}.zip`))
  requireFiles(files, "Squirrel RELEASES metadata", (file) => path.basename(file) === "RELEASES")
} else if (target === "electron-linux") {
  const files = walk(root)
  requireFiles(files, "Linux Debian package", hasBasename(`once_${version}_amd64.deb`))
  requireFiles(files, "Linux Electron ZIP", hasBasename(`Once-linux-x64-${version}.zip`))
} else if (target === "release") {
  const files = walk(root)
  requireFiles(files, "signed Firefox extension XPI", (file) => file.endsWith(`once-firefox-v${version}.xpi`))
  requireFiles(files, "Chrome extension ZIP", (file) => file.endsWith(`once-chrome-v${version}.zip`))
  requireFiles(files, "Electron setup executable", (file) => file.endsWith(`-${version} Setup.exe`))
  requireFiles(files, "Electron full NuGet package", (file) => file.endsWith(`-${version}-full.nupkg`))
  requireFiles(files, "Windows Electron ZIP", hasBasename(`Once-win32-x64-${version}.zip`))
  requireFiles(files, "Squirrel RELEASES metadata", (file) => path.basename(file) === "RELEASES")
  requireFiles(files, "Linux Debian package", hasBasename(`once_${version}_amd64.deb`))
  requireFiles(files, "Linux Electron ZIP", hasBasename(`Once-linux-x64-${version}.zip`))
} else {
  throw new Error("Target must be extensions, electron, electron-linux, or release")
}

console.log(`${target} artifacts verified for v${version}`)
