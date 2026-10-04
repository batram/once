import AVFoundation
import Capacitor
import MediaPlayer
import UIKit

/// The app's one AVAudioSession, wanted by reader speech and, when the user
/// keeps media playing in background, by tab page media. It stays active
/// while either needs it. Main queue only.
final class PlaybackAudioSession {
    static let shared = PlaybackAudioSession()
    /// Android keeps the same choice under the same key.
    private static let keepsPageMediaKey = "background-playback"

    /// Hears of interruptions and of page media starting or stopping.
    weak var reader: ReaderMediaSessionPlugin?
    private var readerActive = false
    private var pagePlaying = false
    /// Page media keeps the session through a pause while the app is in the
    /// background, so its lock screen controls can still resume it.
    private var pageHeld = false
    private var active = false
    private var observers: [NSObjectProtocol] = []

    /// "Keep media playing in background": off by default, as on Android.
    var keepsPageMedia: Bool {
        get { UserDefaults.standard.bool(forKey: Self.keepsPageMediaKey) }
        set {
            UserDefaults.standard.set(newValue, forKey: Self.keepsPageMediaKey)
            apply()
        }
    }

    private init() {
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification,
                                            object: nil, queue: .main) { [weak self] note in
            guard let self, let info = note.userInfo,
                  let raw = info[AVAudioSessionInterruptionTypeKey] as? UInt,
                  AVAudioSession.InterruptionType(rawValue: raw) == .began else { return }
            // The system deactivated it; the next apply reactivates.
            self.active = false
            self.reader?.interrupted()
        })
        // Headphones unplugged: pause rather than speak out loud.
        observers.append(center.addObserver(forName: AVAudioSession.routeChangeNotification,
                                            object: nil, queue: .main) { [weak self] note in
            guard let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
                  AVAudioSession.RouteChangeReason(rawValue: raw) == .oldDeviceUnavailable else { return }
            self?.reader?.interrupted()
        })
        observers.append(center.addObserver(forName: UIApplication.willEnterForegroundNotification,
                                            object: nil, queue: .main) { [weak self] _ in
            guard let self, !self.pagePlaying else { return }
            self.pageHeld = false
            self.apply()
        })
    }

    func setReader(_ active: Bool) {
        readerActive = active
        apply()
    }

    /// Whether any tab plays audible media, whatever the background setting:
    /// WebKit publishes page media to Now Playing itself while it plays.
    func setPagePlaying(_ playing: Bool) {
        guard playing != pagePlaying else { return }
        pagePlaying = playing
        if playing { pageHeld = true } else if UIApplication.shared.applicationState == .active { pageHeld = false }
        apply()
        reader?.pageMediaChanged(playing)
    }

    private func apply() {
        let session = AVAudioSession.sharedInstance()
        guard readerActive || keepsPageMedia && (pagePlaying || pageHeld) else {
            guard active else { return }
            active = false
            // Page media may still be in this session as it stops; busy is harmless.
            try? session.setActive(false, options: .notifyOthersOnDeactivation)
            return
        }
        let mode: AVAudioSession.Mode = readerActive ? .spokenAudio : .default
        do {
            if session.category != .playback || session.mode != mode {
                try session.setCategory(.playback, mode: mode)
            }
            if !active {
                try session.setActive(true)
                active = true
            }
        } catch {
            CAPLog.print("⚡️  Once could not activate the audio session: \(error.localizedDescription)")
        }
    }
}

/// Speaks reader paragraphs on the app's own audio session. The community
/// text-to-speech plugin uses a private session (usesApplicationAudioSession
/// = false) and cannot pause, so its speech neither owns Now Playing nor can
/// be silenced natively from the lock screen. Voice indexes, rates and the
/// queue-and-settle contract match that plugin, so the JS bridge is unchanged.
// Main queue only: the plugin hops there and AVSpeechSynthesizer calls its delegate there.
final class ReaderSpeech: NSObject, AVSpeechSynthesizerDelegate, @unchecked Sendable {
    private let synthesizer = AVSpeechSynthesizer()
    private var pending: [(utterance: AVSpeechUtterance, call: CAPPluginCall)] = []

    override init() {
        super.init()
        synthesizer.usesApplicationAudioSession = true
        synthesizer.delegate = self
    }

    func speak(_ call: CAPPluginCall) {
        let utterance = AVSpeechUtterance(string: call.getString("text") ?? "")
        utterance.voice = AVSpeechSynthesisVoice(language: call.getString("lang") ?? "en-US")
        let voices = AVSpeechSynthesisVoice.speechVoices()
        if let index = call.getInt("voice"), index >= 0, index < voices.count { utterance.voice = voices[index] }
        let rate = call.getFloat("rate") ?? 1
        let base = AVSpeechUtteranceDefaultSpeechRate
        utterance.rate = rate >= 1 ? 0.1 * rate + (base - 0.1) : rate * base
        pending.append((utterance, call))
        synthesizer.speak(utterance)
    }

    /// Queued utterances are dropped without callbacks; settle them all here.
    func stop() {
        let dropped = pending
        pending.removeAll()
        synthesizer.stopSpeaking(at: .immediate)
        dropped.forEach { $0.call.reject("interrupted") }
    }

    /// Silences speech at once; JS then cancels and later re-queues on resume.
    func pause() { synthesizer.pauseSpeaking(at: .immediate) }

    /// A remote play before JS handled the pause it follows.
    func resume() { if synthesizer.isPaused { synthesizer.continueSpeaking() } }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        settle(utterance) { $0.resolve() }
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        settle(utterance) { $0.reject("interrupted") }
    }

    private func settle(_ utterance: AVSpeechUtterance, _ outcome: (CAPPluginCall) -> Void) {
        guard let index = pending.firstIndex(where: { $0.utterance === utterance }) else { return }
        outcome(pending.remove(at: index).call)
    }

    static func voices() -> [[String: Any]] {
        AVSpeechSynthesisVoice.speechVoices().map {
            ["default": false, "lang": $0.language, "localService": true, "name": $0.name, "voiceURI": $0.identifier]
        }
    }
}

/// Lock screen and Control Center controls for reader speech, plus the speech
/// itself (ReaderSpeech). Remote commands silence speech natively where they
/// can, since JS may be suspended while locked, and go to JS as `command`.
@objc(ReaderMediaSessionPlugin)
public class ReaderMediaSessionPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ReaderMediaSessionPlugin"
    public let jsName = "ReaderMediaSession"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "update", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clear", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "speak", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getSupportedVoices", returnType: CAPPluginReturnPromise)
    ]

    private let speech = ReaderSpeech()

    @objc func speak(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            PlaybackAudioSession.shared.setReader(true)
            self.speech.speak(call)
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.speech.stop()
            call.resolve()
        }
    }

    @objc func getSupportedVoices(_ call: CAPPluginCall) {
        call.resolve(["voices": ReaderSpeech.voices()])
    }

    private struct State {
        let title, subtitle: String
        let paused: Bool
        let index, count: Int
    }

    private var state: State?
    /// False while page media, the more recent player, has Now Playing.
    private var ownsNowPlaying = false
    private var targets: [(MPRemoteCommand, Any)] = []

    public override func load() {
        DispatchQueue.main.async { PlaybackAudioSession.shared.reader = self }
    }

    @objc func update(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let next = State(title: call.getString("title") ?? "", subtitle: call.getString("subtitle") ?? "",
                             paused: call.getBool("paused") ?? false,
                             index: call.getInt("index") ?? 0, count: call.getInt("count") ?? 0)
            // Starting or resuming makes speech the most recent player again.
            if self.state.map({ $0.paused && !next.paused }) ?? true { self.ownsNowPlaying = true }
            self.state = next
            PlaybackAudioSession.shared.setReader(true)
            if self.ownsNowPlaying { self.publish() }
            call.resolve()
        }
    }

    @objc func clear(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.state = nil
            self.withdraw()
            PlaybackAudioSession.shared.setReader(false)
            call.resolve()
        }
    }

    func interrupted() {
        guard let state, !state.paused else { return }
        command("pause")
    }

    func pageMediaChanged(_ playing: Bool) {
        guard state != nil else { return }
        ownsNowPlaying = !playing
        if playing { withdraw() } else { publish() }
    }

    private func command(_ action: String) {
        if action == "pause" { speech.pause() }
        if action == "stop" { speech.stop() }
        if action == "play" { speech.resume() }
        notifyListeners("command", data: ["action": action])
    }

    private func publish() {
        guard let state else { return }
        let commands = MPRemoteCommandCenter.shared()
        if targets.isEmpty {
            let actions: [(MPRemoteCommand, String?)] = [
                (commands.playCommand, "play"), (commands.pauseCommand, "pause"),
                (commands.togglePlayPauseCommand, nil), (commands.nextTrackCommand, "next"),
                (commands.previousTrackCommand, "previous"), (commands.stopCommand, "stop")
            ]
            for (remote, action) in actions {
                remote.isEnabled = true
                targets.append((remote, remote.addTarget { [weak self] _ in
                    guard let self, let state = self.state else { return .noActionableNowPlayingItem }
                    self.command(action ?? (state.paused ? "play" : "pause"))
                    return .success
                }))
            }
        }
        commands.previousTrackCommand.isEnabled = state.index > 0
        commands.nextTrackCommand.isEnabled = state.index + 1 < state.count
        // No duration or elapsed time: speech has no honest timeline to scrub.
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: state.title,
            MPMediaItemPropertyArtist: state.subtitle,
            MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.audio.rawValue,
            MPNowPlayingInfoPropertyPlaybackRate: state.paused ? 0.0 : 1.0
        ]
        if state.count > 0 {
            info[MPNowPlayingInfoPropertyChapterNumber] = state.index
            info[MPNowPlayingInfoPropertyChapterCount] = state.count
        }
        let center = MPNowPlayingInfoCenter.default()
        center.nowPlayingInfo = info
        center.playbackState = state.paused ? .paused : .playing
    }

    private func withdraw() {
        for (remote, target) in targets { remote.removeTarget(target) }
        targets.removeAll()
        let center = MPNowPlayingInfoCenter.default()
        center.nowPlayingInfo = nil
        center.playbackState = .stopped
    }
}
