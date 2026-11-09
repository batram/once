package com.zmarn.once;

import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.util.Log;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;
import org.mozilla.geckoview.GeckoResult;
import org.mozilla.geckoview.GeckoSession;
import org.mozilla.geckoview.WebResponse;

/**
 * The PDF a reading page shows, as Gecko's pdf.js viewer holds it. A site
 * behind a bot challenge (Cloudflare's "Just a moment...") lets the page's
 * navigation through once it solved the challenge and answers the reader's own
 * download with 403, so the viewer's copy is the only one the reader can get.
 * Taking it makes no request. The content-script bridge never reaches the
 * viewer, so this goes through the session itself.
 */
final class ReadingPdfBytes {
    private static final int DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

    private ReadingPdfBytes() {}

    /**
     * Resolves { base64, url }, or with nothing when the page is not that PDF,
     * not loaded, or too large. Reader mode has already hidden the page, and an
     * inactive session never answers the save, so `hold` keeps it active
     * (true) until the read is over (false). Runs on the UI thread.
     */
    static void read(PluginCall call, GeckoSession session, String currentUrl, boolean loaded, Consumer<Boolean> hold) {
        String url = call.getString("url", "");
        int maxBytes = call.getInt("maxBytes", DEFAULT_MAX_BYTES);
        if (session == null || !loaded || !ReadingAddress.embeddable(url) || !ReadingAddress.same(currentUrl, url)) {
            call.resolve();
            return;
        }
        hold.accept(true);
        Handler ui = new Handler(Looper.getMainLooper());
        AtomicBoolean released = new AtomicBoolean();
        Runnable release = () -> { if (!released.getAndSet(true)) ui.post(() -> hold.accept(false)); };
        session.isPdfJs().then(pdf -> Boolean.TRUE.equals(pdf)
            ? session.getPdfFileSaver().save()
            : GeckoResult.<WebResponse>fromValue(null)
        ).accept(response -> {
            if (response == null || response.body == null) { release.run(); call.resolve(); return; }
            // The body is a stream that may still be arriving; never read it on the UI thread.
            new Thread(() -> { try { finish(call, response.body, currentUrl, maxBytes); } finally { release.run(); } }, "once-pdf-bytes").start();
        }, error -> {
            release.run();
            Log.w(ReadingSurfaceHost.TAG, "Reading the viewer's PDF failed: " + error);
            call.resolve();
        });
    }

    private static void finish(PluginCall call, InputStream body, String url, int maxBytes) {
        try (InputStream in = body) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[64 * 1024];
            for (int read; (read = in.read(buffer)) != -1; ) {
                if (out.size() + read > maxBytes) { call.resolve(); return; }
                out.write(buffer, 0, read);
            }
            byte[] bytes = out.toByteArray();
            if (!isPdf(bytes)) { call.resolve(); return; }
            call.resolve(new JSObject().put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP)).put("url", url));
        } catch (Exception error) {
            Log.w(ReadingSurfaceHost.TAG, "Reading the viewer's PDF failed", error);
            call.resolve();
        }
    }

    private static boolean isPdf(byte[] bytes) {
        int length = Math.min(bytes.length, 1024);
        return new String(bytes, 0, length, StandardCharsets.ISO_8859_1).contains("%PDF-");
    }
}
