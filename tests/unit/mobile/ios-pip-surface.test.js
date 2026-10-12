const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { execFileSync } = require("node:child_process")

test("iOS keeps the PiP source attached and sized while Stories or another tab is shown", { skip: process.platform !== "darwin" }, () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../../../apps/mobile/ios/App/App/InAppBrowserSurfacePlugin.swift"), "utf8")
  const bounds = source.slice(source.indexOf("    private func applyBounds("), source.indexOf("    @objc func open("))
  const visibility = source.slice(source.indexOf("    func updateSurfaceVisibility()"), source.indexOf("    @objc func showMenu("))
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "once-ios-pip-surface-"))
  const harness = `
import Foundation
import CoreGraphics
typealias JSObject = [String: Any]
final class Parent {
    var front = false
    func bringSubviewToFront(_ view: View) { front = true }
    func sendSubviewToBack(_ view: View) { front = false }
}
final class View {
    var isHidden = true
    var isUserInteractionEnabled = false
    var frame = CGRect.zero
    let superview: Parent? = Parent()
}
final class Surface {
    var surface: View? = View()
    var wantsVisible = true
    var isSelected = true
    var pictureInPictureFrames = Set<String>()
    var savedBounds: JSObject = [:]
${bounds}
${visibility}
    func resize(_ bounds: JSObject) { applyBounds(bounds) }
}
let tab = Surface()
let view = tab.surface!
let frame: JSObject = ["x": 0.0, "y": 120.0, "width": 440.0, "height": 700.0]
tab.resize(frame)
let original = view.frame
tab.updateSurfaceVisibility()
precondition(!view.isHidden && view.isUserInteractionEnabled && view.superview!.front)
tab.pictureInPictureFrames.insert("video-frame")
tab.wantsVisible = false
tab.updateSurfaceVisibility()
tab.resize(["width": 0.0, "height": 0.0])
precondition(!view.isHidden && !view.isUserInteractionEnabled, "Stories must retain PiP without intercepting touches")
precondition(!view.superview!.front && view.frame == original, "PiP source stays behind the shell at its last usable size")
tab.wantsVisible = true
tab.isSelected = false
tab.updateSurfaceVisibility()
precondition(!view.isHidden && !view.isUserInteractionEnabled && !view.superview!.front, "Switching tabs retains PiP")
tab.isSelected = true
tab.resize(frame)
tab.updateSurfaceVisibility()
precondition(!view.isHidden && view.isUserInteractionEnabled && view.superview!.front, "Returning to Reading restores normal interaction")
tab.wantsVisible = false
tab.pictureInPictureFrames.removeAll()
tab.updateSurfaceVisibility()
tab.resize(["width": 0.0, "height": 0.0])
precondition(view.isHidden && !view.isUserInteractionEnabled && view.frame.isEmpty, "Closing PiP restores normal hidden-page behavior")
print("PiP surface lifecycle passed")
`
  try {
    const file = path.join(temporary, "main.swift")
    const executable = path.join(temporary, "pip-surface-test")
    fs.writeFileSync(file, harness)
    // Select the SDK with the compiler; implicit lookup can mix Xcode and Command Line Tools.
    execFileSync("xcrun", ["--sdk", "macosx", "swiftc", file, "-o", executable], { encoding: "utf8", timeout: 60_000 })
    assert.match(execFileSync(executable, { encoding: "utf8", timeout: 10_000 }), /PiP surface lifecycle passed/)
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})
