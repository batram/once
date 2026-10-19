package com.zmarn.once;

import android.net.Uri;
import android.util.Log;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import java.util.Collections;
import org.json.JSONObject;

/**
 * The page's media, as WebChromeClient has no media events: a document-start
 * script reports play/pause and a throttled snapshot of the playing element
 * over a WebMessageListener, and takes play/pause/seek commands back. It runs
 * in the page's main world for this milestone; M2 moves it into the
 * Once-owned content world (docs/plans/once-lite-plan.md).
 */
final class LiteMediaObserver {
    static final String CHANNEL = "onceLiteMedia";
    private final LiteSurfaceHost h;
    /** The current document's reply channel: commands go to that document alone. */
    private JavaScriptReplyProxy reply;

    LiteMediaObserver(LiteSurfaceHost host) { h = host; }

    static boolean supported() {
        return WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
            && WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT);
    }

    void attach(LiteWebView view) {
        if (!supported()) { Log.w(LiteSurfaceHost.TAG, "WebView lacks message listeners; page media is not observed"); return; }
        WebViewCompat.addWebMessageListener(view, CHANNEL, Collections.singleton("*"), (source, message, origin, mainFrame, proxy) -> {
            if (h.surface != view || !mainFrame || message.getType() != WebMessageCompat.TYPE_STRING) return;
            receive(message.getData(), proxy);
        });
        WebViewCompat.addDocumentStartJavaScript(view, SCRIPT, Collections.singleton("*"));
    }

    void detach(LiteWebView view) { reply = null; }

    private void receive(String data, JavaScriptReplyProxy proxy) {
        JSONObject message;
        try { message = new JSONObject(data); } catch (Exception error) { return; }
        if (!"media-snapshot".equals(message.optString("type"))) return;
        if (reply != proxy) {
            // A new document: the old one's media are gone with it.
            reply = proxy;
            if (h.backgroundMedia != null) h.backgroundMedia.attachPage(this::send);
        }
        if (h.backgroundMedia != null) h.backgroundMedia.pageSnapshot(message);
    }

    private void send(JSONObject command) {
        if (reply == null) return;
        try { reply.postMessage(command.toString()); }
        catch (RuntimeException error) { Log.d(LiteSurfaceHost.TAG, "Media page disconnected", error); }
    }

    /** Only http(s) documents report; the shell's own pages never carry the channel. */
    static boolean reports(String url) {
        String scheme = Uri.parse(url == null ? "" : url).getScheme();
        return "https".equals(scheme) || "http".equals(scheme);
    }

    private static final String SCRIPT = "(() => {\n" +
        "  const port = window." + CHANNEL + "; if (!port || window.__onceLiteMediaObserved) return;\n" +
        "  window.__onceLiteMediaObserved = true;\n" +
        "  const playing = new Set(); let current = null, timer = 0, last = 0;\n" +
        "  const meta = () => navigator.mediaSession && navigator.mediaSession.metadata || null;\n" +
        "  const snapshot = () => {\n" +
        "    const el = current || playing.values().next().value || null;\n" +
        "    const m = meta();\n" +
        "    port.postMessage(JSON.stringify({ type: 'media-snapshot', playing: playing.size > 0, url: location.href,\n" +
        "      title: m && m.title || document.title || '', artist: m && m.artist || '',\n" +
        "      position: el ? el.currentTime : null, duration: el && isFinite(el.duration) ? el.duration : null,\n" +
        "      rate: el ? el.playbackRate : 1, seekable: !!el && isFinite(el.duration) && el.duration > 0,\n" +
        "      videoWidth: el && el.videoWidth || 0, videoHeight: el && el.videoHeight || 0 }));\n" +
        "  };\n" +
        "  const now = () => { clearTimeout(timer); timer = 0; last = Date.now(); snapshot(); };\n" +
        "  const soon = () => { const wait = 1000 - (Date.now() - last); if (wait <= 0) now(); else if (!timer) timer = setTimeout(now, wait); };\n" +
        "  const onEvent = event => {\n" +
        "    const el = event.target; if (!(el instanceof HTMLMediaElement)) return;\n" +
        "    current = el;\n" +
        "    if (event.type === 'play' || event.type === 'playing') { playing.add(el); now(); }\n" +
        "    else if (event.type === 'pause' || event.type === 'ended' || event.type === 'emptied') { playing.delete(el); now(); }\n" +
        "    else soon();\n" +
        "  };\n" +
        "  for (const type of ['play', 'playing', 'pause', 'ended', 'emptied', 'timeupdate', 'durationchange', 'ratechange', 'loadedmetadata'])\n" +
        "    document.addEventListener(type, onEvent, true);\n" +
        "  window.addEventListener('pagehide', () => { playing.clear(); now(); });\n" +
        "  port.onmessage = event => {\n" +
        "    let command; try { command = JSON.parse(event.data); } catch (error) { return; }\n" +
        "    if (!command || command.type !== 'media-command') return;\n" +
        "    const el = current || playing.values().next().value || document.querySelector('video, audio'); if (!el) return;\n" +
        "    if (command.action === 'play') { const p = el.play(); if (p && p.catch) p.catch(() => {}); }\n" +
        "    else if (command.action === 'pause') el.pause();\n" +
        "    else if (command.action === 'seek' && typeof command.position === 'number') el.currentTime = command.position;\n" +
        "  };\n" +
        "})();";
}
