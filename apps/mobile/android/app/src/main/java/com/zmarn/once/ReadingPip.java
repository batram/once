package com.zmarn.once;

import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Rect;
import android.util.Log;
import com.getcapacitor.JSObject;
import org.json.JSONObject;
import org.mozilla.geckoview.WebExtension;

/** Standard web-video PiP requests arriving from this session's trusted bridge. */
final class ReadingPip {
    private final ReadingVideo video;
    private final ReadingSurfaceHost host;
    private WebExtension.Port port;
    private long pending;
    private boolean entering;
    private boolean preparedFullscreen;
    boolean direct;
    int width, height;
    private int reportedWidth, reportedHeight;
    private final Runnable timeout = this::timedOut;

    ReadingPip(ReadingVideo video, ReadingSurfaceHost host) { this.video = video; this.host = host; }
    private MainActivity activity() { return (MainActivity) host.getActivity(); }
    boolean supported() { return activity().getPackageManager().hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE); }

    void connect(WebExtension.Port next) {
        if (port != next) {
            cancel();
            if (direct && activity().isInPictureInPictureMode()) {
                activity().startActivity(new Intent(activity(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT));
            }
        }
        port = next;
        if (port != null) send(new JSObject().put("type", "pip-capability").put("enabled", supported()));
    }

    void receive(JSONObject request) {
        long id = request.optLong("id");
        if (id <= 0 || pending != 0) return;
        pending = id;
        entering = "enter".equals(request.optString("action"));
        if (!supported()) { finish("NotSupportedError", "Android PiP is unavailable"); return; }
        host.handler.postDelayed(timeout, 10000);
        if (entering) enter(request);
        else if ("exit".equals(request.optString("action")) && activity().isInPictureInPictureMode()) {
            activity().startActivity(new Intent(activity(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT));
        } else finish("InvalidStateError", "This page is not in PiP");
    }

    private void enter(JSONObject request) {
        if (!host.visible || !host.ownsForeground() || host.session == null || !host.session.isOpen()) {
            finish("NotAllowedError", "The reading page is not visible"); return;
        }
        width = request.optInt("width"); height = request.optInt("height");
        if (width <= 0 || height <= 0 || width > 65536 || height > 65536) {
            finish("InvalidStateError", "The video has no usable dimensions"); return;
        }
        direct = true;
        if (activity().isInPictureInPictureMode()) { state(true); finish(null, null); return; }
        activity().readingVideo = video;
        try {
            Rect source = sourceRect(request.optJSONObject("rect"));
            preparedFullscreen = !video.isFullscreen();
            if (preparedFullscreen) video.fullscreen(true);
            if (!video.enterPip(source)) failedEntry("Android denied PiP");
        } catch (IllegalArgumentException | IllegalStateException error) { failedEntry(error.getMessage()); }
    }

    private Rect sourceRect(JSONObject value) {
        if (value == null || host.surface == null) return null;
        double viewport = value.optDouble("viewportWidth");
        if (!Double.isFinite(viewport) || viewport <= 0) return null;
        double scale = host.surface.getWidth() / viewport;
        int[] origin = new int[2]; host.surface.getLocationOnScreen(origin);
        int left = origin[0] + (int) Math.round(value.optDouble("x") * scale);
        int top = origin[1] + (int) Math.round(value.optDouble("y") * scale);
        Rect rect = new Rect(left, top, left + (int) Math.round(value.optDouble("width") * scale),
            top + (int) Math.round(value.optDouble("height") * scale));
        Rect visible = new Rect();
        return host.surface.getGlobalVisibleRect(visible) && rect.intersect(visible) && !rect.isEmpty() ? rect : null;
    }

    private void failedEntry(String reason) {
        direct = false;
        if (preparedFullscreen) video.fullscreen(false);
        preparedFullscreen = false;
        if (!video.isFullscreen() && activity().readingVideo == video) activity().readingVideo = null;
        sendState(false);
        finish("NotAllowedError", reason == null ? "Android denied PiP" : reason);
    }

    private void timedOut() {
        if (entering && !activity().isInPictureInPictureMode()) failedEntry("Android did not complete the PiP transition");
        else finish("AbortError", "Android did not complete the PiP transition");
    }

    void state(boolean enabled) {
        reportedWidth = reportedHeight = -1;
        sendState(enabled);
        if (pending != 0 && entering == enabled) finish(null, null);
    }

    void resized(boolean enabled) {
        if (enabled) sendState(true);
    }

    private void sendState(boolean enabled) {
        float density = host.getContext().getResources().getDisplayMetrics().density;
        int w = enabled ? Math.round(host.surface.getWidth() / density) : 0;
        int h = enabled ? Math.round(host.surface.getHeight() / density) : 0;
        if (w == reportedWidth && h == reportedHeight) return;
        reportedWidth = w; reportedHeight = h;
        send(new JSObject().put("type", "pip-state").put("enabled", enabled).put("direct", direct).put("width", w).put("height", h));
    }

    private void finish(String name, String error) {
        host.handler.removeCallbacks(timeout);
        if (pending == 0) return;
        JSObject result = new JSObject().put("type", "pip-result").put("id", pending);
        if (error != null) result.put("name", name).put("error", error);
        send(result);
        pending = 0;
    }

    private void send(JSObject message) {
        if (port == null) return;
        try { port.postMessage(message); }
        catch (RuntimeException error) { Log.d("OnceVideo", "PiP page disconnected", error); }
    }

    void cancel() {
        finish("AbortError", "The page disconnected");
        port = null;
    }
}
