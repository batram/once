import WebKit

// Tab media observation: which surfaces play audible media, reported to the
// shell and the shared audio session.
extension InAppBrowserSurfacePlugin {
    func installMediaObserver(_ controller: WKUserContentController) {
        let root = owner ?? self
        if !controller.userScripts.contains(where: { $0 === root.mediaScript }) {
            controller.addUserScript(root.mediaScript)
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
        tab.publishMedia()
    }

    func resetMedia() {
        playingFrames.removeAll()
        publishMedia()
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
    // Media events don't bubble, hence capture on document. An element that
    // played gets direct listeners too: removed from the document, WebKit
    // pauses it where the document no longer hears.
    static let source = """
    (function () {
      if (window.__onceMedia) return;
      window.__onceMedia = true;
      var frame = Math.random().toString(36).slice(2) + Date.now().toString(36);
      var active = new Set();
      var tracked = new WeakSet();
      var types = ['play', 'playing', 'pause', 'ended', 'emptied', 'volumechange'];
      var audible = false;
      function post(value) {
        if (value === audible) return;
        audible = value;
        try { window.webkit.messageHandlers.onceMedia.postMessage({ frame: frame, playing: value }); } catch (e) {}
      }
      function update() {
        var playing = false;
        active.forEach(function (media) {
          if (media.paused || media.ended) active.delete(media);
          else if (!media.muted && media.volume > 0) playing = true;
        });
        post(playing);
      }
      function seen(event) {
        var media = event.target;
        if (!(media instanceof HTMLMediaElement)) return;
        if (!tracked.has(media)) {
          tracked.add(media);
          types.forEach(function (type) { media.addEventListener(type, seen); });
        }
        if (!media.paused && !media.ended) active.add(media);
        update();
      }
      types.forEach(function (type) { document.addEventListener(type, seen, true); });
      window.addEventListener('pagehide', function () { post(false); });
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
