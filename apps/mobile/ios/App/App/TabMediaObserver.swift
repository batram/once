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
        let hadPictureInPicture = !tab.pictureInPictureFrames.isEmpty
        if body["pip"] as? Bool == true { tab.pictureInPictureFrames.insert(frame) }
        else { tab.pictureInPictureFrames.remove(frame) }
        if hadPictureInPicture != !tab.pictureInPictureFrames.isEmpty { tab.updateSurfaceVisibility() }
        tab.publishMedia()
    }

    func resetMedia() {
        playingFrames.removeAll()
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

    fileprivate func publishMedia() {
        let playing = !playingFrames.isEmpty
        guard playing != mediaPlaying else { return }
        mediaPlaying = playing
        pageEvent("mediaStateChanged", data: ["playing": playing])
        let root = owner ?? self
        PlaybackAudioSession.shared.setPagePlaying(root.mediaPlaying || root.tabs.values.contains { $0.mediaPlaying })
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
    static let presentationSource = """
    (function () {
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
      function post(value, pip) {
        if (value === audible && pip === pictureInPicture) return;
        audible = value;
        pictureInPicture = pip;
        state.pictureInPicture = pip;
        try { window.webkit.messageHandlers.onceMedia.postMessage({ frame: frame, playing: value, pip: pip }); } catch (e) {}
      }
      function update() {
        var playing = false;
        active.forEach(function (media) {
          if (media.paused || media.ended) active.delete(media);
          else if (!media.muted && media.volume > 0) playing = true;
        });
        post(playing, pipMedia.size > 0);
      }
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
        update();
      }
      types.forEach(function (type) { document.addEventListener(type, seen, true); });
      window.addEventListener('pagehide', function () { pipMedia.clear(); post(false, false); });
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
