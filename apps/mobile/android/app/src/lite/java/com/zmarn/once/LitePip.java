package com.zmarn.once;

import android.app.PictureInPictureParams;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Rect;
import android.util.Rational;
import com.getcapacitor.JSObject;
import org.json.JSONObject;

/**
 * Standard web-video PiP requests from the tab's bridge world (ReadingPip on
 * GeckoView): the page's polyfill asks to enter or leave, Android PiP takes
 * the activity with the page in it, and the page hears the state back.
 */
final class LitePip {
    private final LiteSurfaceHost host;
    private long pending;
    private boolean entering;
    private int reportedWidth, reportedHeight;
    boolean direct;
    private final Runnable timeout = this::timedOut;

    LitePip(LiteSurfaceHost host) { this.host = host; }
    private MainActivity activity() { return (MainActivity) host.getActivity(); }
    boolean supported() { return activity() != null && activity().getPackageManager().hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE); }

    /** A new document's bridge: it learns whether PiP exists at all. */
    void connected() {
        cancel();
        send(new JSObject().put("type", "pip-capability").put("enabled", supported()));
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
        if (!host.visible || !host.ownsForeground() || host.surface == null) { finish("NotAllowedError", "The reading page is not visible"); return; }
        int width = request.optInt("width"), height = request.optInt("height");
        if (width <= 0 || height <= 0 || width > 65536 || height > 65536) { finish("InvalidStateError", "The video has no usable dimensions"); return; }
        direct = true;
        if (activity().isInPictureInPictureMode()) { state(true); finish(null, null); return; }
        activity().readingVideo = host.video;
        try {
            PictureInPictureParams.Builder params = new PictureInPictureParams.Builder()
                .setAspectRatio(new Rational((int) Math.max(4185, Math.min(23900, Math.round((double) width / height * 10000))), 10000));
            Rect source = sourceRect(request.optJSONObject("rect"));
            if (source != null) params.setSourceRectHint(source);
            if (!activity().enterPictureInPictureMode(params.build())) failedEntry("Android denied PiP");
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
        Rect rect = new Rect(left, top, left + (int) Math.round(value.optDouble("width") * scale), top + (int) Math.round(value.optDouble("height") * scale));
        Rect visible = new Rect();
        return host.surface.getGlobalVisibleRect(visible) && rect.intersect(visible) && !rect.isEmpty() ? rect : null;
    }

    private void failedEntry(String reason) {
        direct = false;
        if (activity().readingVideo == host.video && !host.video.isFullscreen()) activity().readingVideo = null;
        sendState(false);
        finish("NotAllowedError", reason == null ? "Android denied PiP" : reason);
    }

    private void timedOut() {
        if (entering && !activity().isInPictureInPictureMode()) failedEntry("Android did not complete the PiP transition");
        else finish("AbortError", "Android did not complete the PiP transition");
    }

    /** The activity entered or left PiP. */
    void state(boolean enabled) {
        reportedWidth = reportedHeight = -1;
        sendState(enabled);
        if (!enabled) direct = false;
        if (pending != 0 && entering == enabled) finish(null, null);
    }

    private void sendState(boolean enabled) {
        if (host.surface == null) return;
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

    private void send(JSObject message) { host.bridge.send(message); }

    void cancel() { finish("AbortError", "The page disconnected"); }
}
