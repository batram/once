const { spawnSync } = require("node:child_process")
const fs = require("node:fs")
const path = require("node:path")

const directory = path.resolve(__dirname, "../.native")

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Native build failed: ${command}`)
}

const upToDate = (output, source) => fs.existsSync(output) && fs.statSync(output).mtimeMs >= fs.statSync(source).mtimeMs

// A universal helper works in both Intel and Apple Silicon application bundles.
function buildMacImageText() {
  const source = path.resolve(__dirname, "../native/ImageText.swift")
  const output = path.join(directory, "once-image-text")
  const entitlements = path.resolve(__dirname, "../native/image-text.entitlements.plist")
  // A sandboxed command-line tool needs a bundle identifier from an Info.plist
  // bound into its signature (macOS 27 traps in libsecinit without one), so the
  // plist is linked into __TEXT,__info_plist where codesign picks it up.
  const infoPlist = path.resolve(__dirname, "../native/image-text.Info.plist")
  if ([source, entitlements, infoPlist].every(input => upToDate(output, input))) return
  fs.mkdirSync(directory, { recursive: true })
  for (const arch of ["arm64", "x86_64"]) {
    run("xcrun", ["swiftc", "-O", "-target", `${arch}-apple-macosx12.0`,
      "-module-cache-path", path.join(directory, "module-cache"), source, "-o", `${output}-${arch}`,
      "-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", infoPlist])
  }
  run("xcrun", ["lipo", "-create", `${output}-arm64`, `${output}-x86_64`, "-output", output])
  run("codesign", ["--force", "--sign", "-", "--identifier", "app.once.image-text", "--entitlements", entitlements, output])
}

/**
 * Compiles one C++ file with the newest installed MSVC. The static CRT keeps
 * the output free of a VC++ redistributable dependency. Rebuilt when the
 * source is newer or the target architecture changed.
 */
function buildMsvc(name, arch, { source, output, flags = [], libs, dependencies = [] }) {
  const stamp = path.join(directory, `${name}.arch`)
  if ([source, ...dependencies].every(input => upToDate(output, input)) && fs.existsSync(stamp) && fs.readFileSync(stamp, "utf8") === arch) return
  const vswhere = path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft Visual Studio", "Installer", "vswhere.exe")
  const found = spawnSync(vswhere, ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
    "-property", "installationPath"], { encoding: "utf8" })
  const installation = found.stdout?.trim().split(/\r?\n/)[0]
  if (!installation) throw new Error(`${name} needs Visual Studio C++ build tools (vswhere found none)`)
  const target = { x64: "x64", arm64: "x64_arm64" }[arch]
  if (!target) throw new Error(`${name}: unsupported Windows arch ${arch}`)
  const objects = path.join(directory, "obj", name)
  fs.mkdirSync(objects, { recursive: true })
  const script = path.join(directory, `build-${name}.cmd`)
  fs.writeFileSync(script, [
    "@echo off",
    // vcvarsall itself looks for vswhere on PATH.
    `set "PATH=${path.dirname(vswhere)};%PATH%"`,
    `call "${path.join(installation, "VC", "Auxiliary", "Build", "vcvarsall.bat")}" ${target} >nul || exit /b 1`,
    `cl /nologo /std:c++20 /EHsc /O2 /MT /permissive- /utf-8 /W4 ${flags.join(" ")} "${source}" /Fo"${objects}\\\\" /Fe"${output}" /link ${libs.join(" ")}`
  ].join("\r\n"))
  run("cmd", ["/d", "/c", script], { windowsHide: true })
  fs.writeFileSync(stamp, arch)
}

/** Native OCR helper: Apple Vision / Windows.Media.Ocr (C++/WinRT). */
function buildImageText(arch) {
  if (process.platform === "darwin") buildMacImageText()
  else if (process.platform === "win32") {
    buildMsvc("once-image-text", arch, {
      source: path.resolve(__dirname, "../native/ImageText.cpp"),
      output: path.join(directory, "once-image-text.exe"),
      dependencies: [path.resolve(__dirname, "../native/ImageTextSandbox.h")],
      libs: ["windowsapp.lib", "userenv.lib", "advapi32.lib"]
    })
  }
}

/** Node-API addon that cloaks shell windows until their first frame (src/browser/windowCloak.ts). */
function buildWindowCloak(arch) {
  if (process.platform !== "win32") return
  buildMsvc("window-cloak", arch, {
    source: path.resolve(__dirname, "../native/WindowCloak.cpp"),
    output: path.join(directory, "window-cloak.node"),
    flags: ["/LD"],
    libs: ["dwmapi.lib", "user32.lib"]
  })
}

function buildNative(arch = process.argv.find((arg) => arg.startsWith("--arch="))?.slice(7) ?? process.arch) {
  buildImageText(arch)
  buildWindowCloak(arch)
}

module.exports = { buildNative }
if (require.main === module) buildNative()
