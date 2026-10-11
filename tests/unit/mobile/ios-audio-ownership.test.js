const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { execFileSync } = require("node:child_process")

test("WebKit page playback never activates the reader's native audio session", { skip: process.platform !== "darwin" }, () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../../../apps/mobile/ios/App/App/ReaderMediaSession.swift"), "utf8")
  const audio = source.slice(source.indexOf("final class PlaybackAudioSession"), source.indexOf("/// Speaks reader paragraphs"))
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "once-ios-audio-"))
  const harness = `
import Foundation
final class UserDefaults {
    static let standard = UserDefaults()
    var values: [String: Bool] = [:]
    func bool(forKey key: String) -> Bool { values[key] ?? false }
    func set(_ value: Bool, forKey key: String) { values[key] = value }
}
let AVAudioSessionInterruptionTypeKey = "interruption"
let AVAudioSessionRouteChangeReasonKey = "route"
final class AVAudioSession {
    enum Category { case ambient, playback }
    enum Mode { case \`default\`, spokenAudio }
    enum InterruptionType: UInt { case began = 1 }
    enum RouteChangeReason: UInt { case oldDeviceUnavailable = 1 }
    struct Options: OptionSet {
        let rawValue: Int
        static let notifyOthersOnDeactivation = Options(rawValue: 1)
    }
    static let interruptionNotification = Notification.Name("interruption")
    static let routeChangeNotification = Notification.Name("route")
    static let instance = AVAudioSession()
    static func sharedInstance() -> AVAudioSession { instance }
    var category = Category.ambient
    var mode = Mode.default
    var activations: [Bool] = []
    func setCategory(_ category: Category, mode: Mode) throws { self.category = category; self.mode = mode }
    func setActive(_ active: Bool, options: Options = []) throws { activations.append(active) }
}
final class ReaderMediaSessionPlugin {
    var pageEvents: [Bool] = []
    func interrupted() {}
    func pageMediaChanged(_ playing: Bool) { pageEvents.append(playing) }
}
enum CAPLog { static func print(_ text: String) {} }
${audio}
let owner = PlaybackAudioSession.shared
let system = AVAudioSession.sharedInstance()
let reader = ReaderMediaSessionPlugin()
owner.reader = reader
for background in [false, true] {
    owner.keepsPageMedia = background
    owner.setPagePlaying(true)
    owner.setPagePlaying(false)
    precondition(system.activations.isEmpty, "Page playback must leave WebKit's audio session in control")
}
precondition(reader.pageEvents == [true, false, true, false], "Reader controls must still hear page playback")
owner.setReader(true)
precondition(system.activations == [true] && system.mode == .spokenAudio, "Reader speech still owns native audio")
owner.setPagePlaying(true)
owner.setPagePlaying(false)
precondition(system.activations == [true], "Page events must not repeatedly activate native audio")
owner.setReader(false)
precondition(system.activations == [true, false], "Ending reader speech releases its audio session")
print("Native audio ownership passed")
`
  try {
    const file = path.join(temporary, "main.swift")
    const executable = path.join(temporary, "audio-test")
    fs.writeFileSync(file, harness)
    execFileSync("xcrun", ["swiftc", file, "-o", executable], { encoding: "utf8", timeout: 60_000 })
    assert.match(execFileSync(executable, { encoding: "utf8", timeout: 10_000 }), /Native audio ownership passed/)
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})
