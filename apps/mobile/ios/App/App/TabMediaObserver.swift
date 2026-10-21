import MediaPlayer
import WebKit

// Tab media observation: which surfaces play audible media, reported to the
// shell and the shared audio session.
extension InAppBrowserSurfacePlugin {
    func installMediaObserver(_ controller: WKUserContentController) {
        let root = owner ?? self
        if !controller.userScripts.contains(where: { $0 === root.mediaScript }) {
            controller.addUserScript(root.mediaScript)
        }
        if !controller.userScripts.contains(where: { $0 === root.mediaPresentationScript }) {
            controller.addUserScript(root.mediaPresentationScript)
        }
        guard !root.mediaControllers.contains(controller) else { return }
        root.mediaControllers.add(controller)
        controller.add(MediaObserver(root), contentWorld: MediaObserver.world, name: "onceMedia")
    }

    /// Root-only: one handler may serve several surfaces, so find the sender's tab.
    fileprivate func mediaMessage(_ message: WKScriptMessage) {
        guard let view = message.webView,
              let tab = surface === view ? self : tabs.values.first(where: { $0.surface === view }),
              let body = message.body as? [String: Any],
              let frame = body["frame"] as? String,
              let playing = body["playing"] as? Bool else { return }
        if playing { tab.playingFrames.insert(frame) } else { tab.playingFrames.remove(frame) }
        if body["held"] as? Bool == true { tab.mediaFrames[frame] = message.frameInfo }
        else { tab.mediaFrames.removeValue(forKey: frame) }
        let hadPictureInPicture = !tab.pictureInPictureFrames.isEmpty
        if body["pip"] as? Bool == true { tab.pictureInPictureFrames.insert(frame) }
        else { tab.pictureInPictureFrames.remove(frame) }
        if hadPictureInPicture != !tab.pictureInPictureFrames.isEmpty { tab.updateSurfaceVisibility() }
        tab.publishMedia()
    }

    func resetMedia() {
        playingFrames.removeAll()
        mediaFrames.removeAll()
        pictureInPictureFrames.removeAll()
        updateSurfaceVisibility()
        publishMedia()
    }

    /// PiP is visible playback. Recheck WebKit's presentation mode as the app
    /// backgrounds, since its script message may still be in flight.
    func pauseUnlessPictureInPicture() {
        guard pictureInPictureFrames.isEmpty, let view = surface else { return }
        view.evaluateJavaScript("window.__onceMedia && window.__onceMedia.pictureInPicture",
                                in: nil, in: MediaObserver.world) { [weak self, weak view] result in
            guard let self, let view, self.surface === view,
                  UIApplication.shared.applicationState == .background,
                  !PlaybackAudioSession.shared.keepsPageMedia,
                  self.pictureInPictureFrames.isEmpty else { return }
            if case .success(let pip) = result, pip as? Bool == true { return }
            view.pauseAllMediaPlayback {}
        }
    }

    /// The audio background mode (for reader speech) would otherwise let
    /// page audio play on; unless the user keeps it, pause it as before.
    /// When kept, WebKit still interrupts audible video as the app leaves
    /// the foreground, so the playing frames resume it. Locking resigns
    /// active, becomes active and resigns again, and WebKit's pause may
    /// land in between, so forgetting the armed media waits a moment.
    func observeBackgroundMedia() -> [NSObjectProtocol] {
        let center = NotificationCenter.default
        return [
            center.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
                self?.pendingMediaClear?.cancel()
                guard let self, PlaybackAudioSession.shared.keepsPageMedia else { return }
                for tab in [self] + Array(self.tabs.values) { tab.backgroundMedia("arm") }
            },
            center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
                guard let self else { return }
                let keeps = PlaybackAudioSession.shared.keepsPageMedia
                for tab in [self] + Array(self.tabs.values) {
                    if keeps { tab.backgroundMedia("resume") } else { tab.pauseUnlessPictureInPicture() }
                }
                if keeps { self.holdPausedMedia() }
            },
            center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
                PageMediaRemote.shared.release()
                guard let self else { return }
                let clear = DispatchWorkItem { [weak self] in
                    guard let self else { return }
                    for tab in [self] + Array(self.tabs.values) { tab.backgroundMedia("clear") }
                }
                self.pendingMediaClear = clear
                DispatchQueue.main.asyncAfter(deadline: .now() + 1, execute: clear)
            },
        ]
    }

    /// Root-only. Once resumed media had a moment to report playing, media
    /// still paused gets the app's own lock-screen commands.
    private func holdPausedMedia() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
            guard let self, UIApplication.shared.applicationState == .background else { return }
            let all = [self] + Array(self.tabs.values)
            guard !all.contains(where: { $0.mediaPlaying }),
                  let held = all.first(where: { !$0.armedFrames.isEmpty }) else { return }
            PageMediaRemote.shared.hold { [weak held] in held?.backgroundMedia("play") }
        }
    }

    /// The kept-media policy around WebKit's background interruption: "arm"
    /// as the app resigns active remembers what plays audibly and keeps the
    /// page visible while it holds media to resume, "resume" once
    /// backgrounded plays it again, "clear" on return forgets it. Arming adds
    /// up until cleared, and the frames armed stay addressed: WebKit's pause
    /// may report a frame silent before it hears "resume".
    func backgroundMedia(_ phase: String) {
        if phase == "arm" { armedFrames.merge(mediaFrames) { $1 } }
        let frames = Array(armedFrames.values)
        if phase == "clear" { armedFrames.removeAll() }
        guard let view = surface else { return }
        for frame in frames {
            view.callAsyncJavaScript("window.__onceMedia && window.__onceMedia.background(phase)",
                                     arguments: ["phase": phase], in: frame, in: MediaObserver.world)
        }
    }

    fileprivate func publishMedia() {
        let playing = !playingFrames.isEmpty
        guard playing != mediaPlaying else { return }
        mediaPlaying = playing
        pageEvent("mediaStateChanged", data: ["playing": playing])
        let root = owner ?? self
        PlaybackAudioSession.shared.setPagePlaying(root.mediaPlaying || root.tabs.values.contains { $0.mediaPlaying })
        if playing { PageMediaRemote.shared.release() }
    }
}

/// Lock-screen play for kept page media paused in the background. Without
/// commands of the app's own, the suspended app's web process hears WebKit's
/// play only once the app returns. Registered, iOS lets WebKit's command
/// through and the page plays; the app's target plays the held media should
/// it get the command instead. WebKit's Now Playing entry stays as it is:
/// publishing one here flashes it. Main queue only.
final class PageMediaRemote {
    static let shared = PageMediaRemote()
    private var targets: [(MPRemoteCommand, Any)] = []
    private var play: (() -> Void)?

    func hold(_ play: @escaping () -> Void) {
        self.play = play
        let commands = MPRemoteCommandCenter.shared()
        if targets.isEmpty {
            for remote in [commands.playCommand, commands.togglePlayPauseCommand] {
                remote.isEnabled = true
                targets.append((remote, remote.addTarget { [weak self] _ in
                    guard let play = self?.play else { return .noActionableNowPlayingItem }
                    play()
                    return .success
                }))
            }
        }
    }

    func release() {
        guard play != nil else { return }
        play = nil
        for (remote, target) in targets { remote.removeTarget(target) }
        targets.removeAll()
    }
}

/// Reports, per frame, whether any <audio>/<video> plays audibly. WebKit exposes
/// no such state publicly. Runs in its own content world so page script can
/// neither post to the handler nor tamper with the observer.
final class MediaObserver: NSObject, WKScriptMessageHandler {
    static let world = WKContentWorld.world(name: "OnceMedia")
    /// Runs in the page world before players cache WebKit's legacy methods.
    /// YouTube calls webkitExitFullscreen after native fullscreen enters PiP;
    /// WebKit treats it as a PiP exit too. Exiting fullscreen should leave the
    /// user's separate PiP presentation alone. Native PiP close and explicit
    /// exitPictureInPicture / webkitSetPresentationMode("inline") still work.
    /// While the observer keeps media playing in the background, the page
    /// is told it stays visible: YouTube unloads its video once hidden.
    static let presentationSource = """
    (function () {
      var kept = false;
      window.addEventListener('oncemediakept', function () { kept = true; }, true);
      window.addEventListener('oncemediareleased', function () { kept = false; }, true);
      [['hidden', false], ['webkitHidden', false], ['visibilityState', 'visible'], ['webkitVisibilityState', 'visible']].forEach(function (entry) {
        var descriptor = Object.getOwnPropertyDescriptor(Document.prototype, entry[0]);
        if (!descriptor || typeof descriptor.get !== 'function') return;
        var original = descriptor.get;
        descriptor.get = function () { return kept ? entry[1] : original.call(this); };
        Object.defineProperty(Document.prototype, entry[0], descriptor);
      });
      ['visibilitychange', 'webkitvisibilitychange'].forEach(function (type) {
        window.addEventListener(type, function (event) { if (kept) event.stopImmediatePropagation(); }, true);
      });
      ['webkitExitFullscreen', 'webkitExitFullScreen'].forEach(function (name) {
        var prototype = HTMLVideoElement.prototype;
        var descriptor = Object.getOwnPropertyDescriptor(prototype, name);
        if (!descriptor || typeof descriptor.value !== 'function') return;
        var original = descriptor.value;
        descriptor.value = function () {
          if (this.webkitPresentationMode === 'picture-in-picture') return;
          return original.apply(this, arguments);
        };
        Object.defineProperty(prototype, name, descriptor);
      });
    })();
    """
    // Media events don't bubble, hence capture on document. An element that
    // played gets direct listeners too: removed from the document, WebKit
    // pauses it where the document no longer hears.
    // iOS WebKit interrupts audible video (not audio or PiP) as the app
    // enters the background, but lets script play it again afterwards. With
    // media kept, armed elements resume if paused around that moment only,
    // so a later pause from the lock screen sticks. Media that played
    // audibly is held until emptied or ended: paused, it stays loaded for
    // the lock screen to play again.
    static let source = """
    (function () {
      if (window.__onceMedia) return;
      var state = window.__onceMedia = { pictureInPicture: false };
      var frame = Math.random().toString(36).slice(2) + Date.now().toString(36);
      var active = new Set();
      var pipMedia = new Set();
      var tracked = new WeakSet();
      var presentation = new WeakMap();
      var types = ['play', 'playing', 'pause', 'ended', 'emptied', 'volumechange', 'webkitpresentationmodechanged', 'enterpictureinpicture', 'leavepictureinpicture'];
      var audible = false;
      var pictureInPicture = false;
      var armed = new Set();
      var resumeUntil = 0;
      var held = new Set();
      var last = null;
      var holding = false;
      function post(value, pip) {
        var holds = held.size > 0;
        if (value === audible && pip === pictureInPicture && holds === holding) return;
        audible = value;
        pictureInPicture = pip;
        holding = holds;
        state.pictureInPicture = pip;
        try { window.webkit.messageHandlers.onceMedia.postMessage({ frame: frame, playing: value, pip: pip, held: holds }); } catch (e) {}
      }
      function update() {
        var playing = false;
        active.forEach(function (media) {
          if (media.paused || media.ended) active.delete(media);
          else if (!media.muted && media.volume > 0) { playing = true; held.add(media); last = media; }
        });
        post(playing, pipMedia.size > 0);
      }
      function resume(media) {
        if (!media.paused || media.ended) return;
        armed.delete(media);
        var played = media.play();
        if (played) played.catch(function () {});
      }
      state.background = function (phase) {
        if (phase === 'arm') {
          active.forEach(function (media) {
            if (!media.paused && !media.ended && !media.muted && media.volume > 0) armed.add(media);
          });
          if (held.size) window.dispatchEvent(new Event('oncemediakept'));
        } else if (phase === 'play') {
          if (last && held.has(last)) resume(last);
        } else if (phase === 'resume') {
          resumeUntil = Date.now() + 3000;
          armed.forEach(resume);
        } else {
          armed.clear();
          resumeUntil = 0;
          window.dispatchEvent(new Event('oncemediareleased'));
        }
      };
      function seen(event) {
        var media = event.target;
        if (!(media instanceof HTMLMediaElement)) return;
        if (!tracked.has(media)) {
          tracked.add(media);
          types.forEach(function (type) { media.addEventListener(type, seen); });
        }
        if (!media.paused && !media.ended) active.add(media);
        // WebKit can leave pictureInPictureElement pointing at the video
        // after a legacy presentation-mode exit. Explicit events win over
        // that stale getter, including on subsequent play/pause events.
        if (event.type === 'webkitpresentationmodechanged') presentation.set(media, media.webkitPresentationMode === 'picture-in-picture');
        else if (event.type === 'enterpictureinpicture') presentation.set(media, true);
        else if (event.type === 'leavepictureinpicture' || event.type === 'emptied') presentation.set(media, false);
        var pip = presentation.has(media) ? presentation.get(media) :
          media.webkitPresentationMode === 'picture-in-picture' || document.pictureInPictureElement === media;
        if (pip) pipMedia.add(media);
        else pipMedia.delete(media);
        if (event.type === 'pause' && armed.has(media) && Date.now() < resumeUntil) resume(media);
        if (event.type === 'emptied' || event.type === 'ended') held.delete(media);
        update();
      }
      types.forEach(function (type) { document.addEventListener(type, seen, true); });
      window.addEventListener('pagehide', function () { pipMedia.clear(); held.clear(); post(false, false); });
      window.addEventListener('pageshow', function (event) { if (event.persisted) update(); });
    })();
    """

    /// The controller retains its handlers; weak so it doesn't retain the plugin.
    private weak var root: InAppBrowserSurfacePlugin?

    init(_ root: InAppBrowserSurfacePlugin) { self.root = root }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        root?.mediaMessage(message)
    }
}
