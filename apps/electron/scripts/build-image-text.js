const { spawnSync } = require("node:child_process")
const fs = require("node:fs")
const path = require("node:path")

const directory = path.resolve(__dirname, "../.native")

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Image text helper build failed: ${command}`)
}

const upToDate = (output, source) => fs.existsSync(output) && fs.statSync(output).mtimeMs >= fs.statSync(source).mtimeMs

// A universal helper works in both Intel and Apple Silicon application bundles.
function buildMac() {
  const source = path.resolve(__dirname, "../native/ImageText.swift")
  const output = path.join(directory, "once-image-text")
  if (upToDate(output, source)) return
  fs.mkdirSync(directory, { recursive: true })
  for (const arch of ["arm64", "x86_64"]) {
    run("xcrun", ["swiftc", "-O", "-target", `${arch}-apple-macosx12.0`,
      "-module-cache-path", path.join(directory, "module-cache"), source, "-o", `${output}-${arch}`])
  }
  run("xcrun", ["lipo", "-create", `${output}-arm64`, `${output}-x86_64`, "-output", output])
  run("codesign", ["--force", "--sign", "-", output])
}

// Windows.Media.Ocr through C++/WinRT, built with the newest installed MSVC.
// The static CRT keeps the helper free of a VC++ redistributable dependency.
function buildWindows(arch) {
  const source = path.resolve(__dirname, "../native/ImageText.cpp")
  const output = path.join(directory, "once-image-text.exe")
  const stamp = path.join(directory, "once-image-text.arch")
  if (upToDate(output, source) && fs.existsSync(stamp) && fs.readFileSync(stamp, "utf8") === arch) return
  const vswhere = path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft Visual Studio", "Installer", "vswhere.exe")
  const found = spawnSync(vswhere, ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
    "-property", "installationPath"], { encoding: "utf8" })
  const installation = found.stdout?.trim().split(/\r?\n/)[0]
  if (!installation) throw new Error("Image text helper needs Visual Studio C++ build tools (vswhere found none)")
  const target = { x64: "x64", arm64: "x64_arm64" }[arch]
  if (!target) throw new Error(`Image text helper: unsupported Windows arch ${arch}`)
  fs.mkdirSync(path.join(directory, "obj"), { recursive: true })
  const script = path.join(directory, "build-image-text.cmd")
  fs.writeFileSync(script, [
    "@echo off",
    // vcvarsall itself looks for vswhere on PATH.
    `set "PATH=${path.dirname(vswhere)};%PATH%"`,
    `call "${path.join(installation, "VC", "Auxiliary", "Build", "vcvarsall.bat")}" ${target} >nul || exit /b 1`,
    `cl /nologo /std:c++20 /EHsc /O2 /MT /permissive- /utf-8 /W4 "${source}" /Fo"${path.join(directory, "obj")}\\\\" /Fe"${output}" /link windowsapp.lib`
  ].join("\r\n"))
  run("cmd", ["/d", "/c", script], { windowsHide: true })
  fs.writeFileSync(stamp, arch)
}

function buildImageText(arch = process.argv.find((arg) => arg.startsWith("--arch="))?.slice(7) ?? process.arch) {
  if (process.platform === "darwin") buildMac()
  else if (process.platform === "win32") buildWindows(arch)
}

module.exports = { buildImageText }
if (require.main === module) buildImageText()
