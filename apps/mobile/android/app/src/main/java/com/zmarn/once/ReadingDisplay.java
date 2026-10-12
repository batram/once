package com.zmarn.once;

import android.os.SystemClock;
import android.util.Log;
import android.view.SurfaceView;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewTreeObserver;
import android.webkit.WebView;
import com.getcapacitor.JSObject;
import org.mozilla.geckoview.GeckoSession;
import org.mozilla.geckoview.GeckoView;
import org.json.JSONObject;

/** Owns display attachment, bounded repair and readiness checks independently of navigation. */
final class ReadingDisplay {
    private final ReadingSurfaceHost h;
    ReadingDisplay(ReadingSurfaceHost host) { h = host; }

    void painted(GeckoSession source) {
        if (h.session != source) return;
        h.painted = true;
        h.documentPainted = true;
        trace("paint");
        requestHealthCheck();
    }

    void resetPaint(GeckoSession source) {
        if (h.session != source) return;
        h.painted = false;
        h.navigationCompleted = false;
        h.repairVerified = false;
        h.blankSince = 0;
        h.nextHealthAt = 0;
        // A reset (the GPU process restarted, say, which Android schedules
        // seconds after resume) needs its own repair: an already painted
        // document reports no new first paint, and with the repair spent the
        // blank check failed a page that was still playing underneath.
        h.displayReattached = false;
    }

    void attach() {
        if (h.surface == null || h.session == null || !h.session.isOpen() || !h.visible || !h.resumed
            || h.surface.getWidth() <= 1 || h.surface.getHeight() <= 1 || !h.surface.isShown()) return;
        if (h.surface.getSession() != h.session) {
            h.surface.setSession(h.session);
            trace("display-attached");
        }
    }

    /** Retain the document, history and scripts when repairing only the display. */
    void repair() {
        if (h.displayReattached || !h.visible || !h.resumed || h.surface == null || h.session == null
            || !h.session.isOpen() || h.surface.getWidth() <= 1 || h.surface.getHeight() <= 1) return;
        h.displayReattached = true;
        trace("display-reattach");
        if (h.loadStatus != null) h.loadStatus.show("Displaying page…");
        h.surface.releaseSession();
        attach();
        GeckoSession repaired = h.session;
        long navigation = h.activeNavigation;
        // Cached/previously painted documents need not emit first-paint again.
        // Capture provides a bounded, asynchronous renderer response after the
        // display reattachment, without guessing readiness from a timer alone.
        h.surface.capturePixels().accept(pixels -> {
            try {
                if (repaired != h.session || navigation != h.activeNavigation || h.destroyed) return;
                h.repairVerified = pixels.getWidth() > 0 && pixels.getHeight() > 0;
                trace("display-verified");
                requestHealthCheck();
            } finally { pixels.recycle(); }
        }, error -> {
            if (repaired == h.session && navigation == h.activeNavigation) trace("display-verification-failed");
        });
        requestHealthCheck();
    }

    /**
     * Android can leave the view's SurfaceView layer on a window surface it has
     * since replaced (seen on Samsung Android 13 after returning from the
     * launcher): Gecko keeps painting into an offscreen layer and the page stays
     * black, whatever is reloaded. Hiding the SurfaceView for a frame releases
     * that layer; showing it again creates one on the current window.
     */
    void recreateSurface() {
        SurfaceView view = surfaceView();
        if (view == null || view.getVisibility() != View.VISIBLE) return;
        trace("surface-recreate");
        view.setVisibility(View.INVISIBLE);
        view.post(() -> view.setVisibility(View.VISIBLE));
    }

    /** After a stop the window gets its new surface only once it draws again. */
    void recreateSurfaceAfterDraw() {
        GeckoView view = h.surface;
        if (view == null) return;
        ViewTreeObserver.OnDrawListener listener = new ViewTreeObserver.OnDrawListener() {
            private boolean drawn;
            @Override
            public void onDraw() {
                if (drawn) return;
                drawn = true;
                // Listeners cannot be removed from inside the draw pass.
                view.post(() -> {
                    view.getViewTreeObserver().removeOnDrawListener(this);
                    if (view == h.surface && !h.destroyed) recreateSurface();
                });
            }
        };
        view.getViewTreeObserver().addOnDrawListener(listener);
    }

    private SurfaceView surfaceView() {
        if (h.surface == null) return null;
        for (int i = 0; i < h.surface.getChildCount(); i++) {
            View child = h.surface.getChildAt(i);
            if (child instanceof SurfaceView) return (SurfaceView) child;
        }
        return null;
    }

    void trace(String stage) {
        Log.i(ReadingSurfaceHost.TAG, "load " + stage + " navigation=" + h.activeNavigation
            + " elapsedMs=" + (h.loadStartedAt == 0 ? 0 : SystemClock.elapsedRealtime() - h.loadStartedAt)
            + " visible=" + h.visible + " painted=" + h.painted
            + " size=" + (h.surface == null ? "none" : h.surface.getWidth() + "x" + h.surface.getHeight()));
    }

    /** The shell's setVisible; `covered`: hidden under a view of its own that stays up (a comment thread). */
    void show(boolean visible, boolean covered) {
        h.coveredByShell = !visible && covered;
        h.setSurfaceVisible(visible);
        // A page that stopped while on screen waits for a health reply the
        // hidden page no longer gets; under a lasting cover it is done.
        if (h.coveredByShell && !h.navigationCompleted && h.activeNavigation != 0 && h.stoppedNavigation == h.activeNavigation
            && h.session != null && h.session.isOpen()) h.documentReady();
    }

    void requestHealthCheck() {
        h.nextHealthAt = 0;
        h.handler.removeCallbacks(h.watchdog);
        if (!h.destroyed && h.visible && h.resumed && h.session != null && h.pageRequested && !h.recoveryFailed)
            h.handler.post(h.watchdog);
    }

    void pauseWatchdog() {
        h.handler.removeCallbacks(h.watchdog);
        h.healthSentAt = 0;
    }

    void resumeWatchdog() {
        h.handler.removeCallbacks(h.watchdog);
        if (!h.destroyed && h.visible && h.resumed && h.session != null && h.pageRequested && !h.recoveryFailed)
            h.handler.postDelayed(h.watchdog, h.navigationCompleted ? 1000 : 250);
    }

    void checkHealth() {
        if (h.destroyed || !h.visible || !h.resumed || h.session == null || h.recoveryFailed) return;
        long now = SystemClock.elapsedRealtime();
        if (h.healthSentAt != 0 && now - h.healthSentAt >= ReadingSurfaceHost.RESPONSE_TIMEOUT_MS) {
            h.recoverPage("The page stopped responding", true);
            return;
        }
        if (h.navigationDeadline != 0 && now >= h.navigationDeadline) {
            h.recoverPage("The page did not become ready in time", true);
            return;
        }
        if (h.bridgePort != null && h.healthSentAt == 0 && now >= h.nextHealthAt && ReadingAddress.embeddable(h.currentUrl)) {
            try {
                h.healthId++;
                h.healthSentAt = now;
                h.bridgePort.postMessage(new JSONObject().put("type", "health").put("id", h.healthId));
            } catch (Exception error) { h.healthSentAt = 0; h.bridgePort = null; h.armNavigation(); }
        }
        resumeWatchdog();
    }

    void progress(GeckoSession source, int progress) {
        if (source != h.session || h.initialBlank || !h.pageRequested || h.navigationCompleted || h.loadStatus == null
            || h.recoveryView != null && h.recoveryView.getVisibility() == android.view.View.VISIBLE) return;
        h.loadStatus.show(progress >= 100 ? "Displaying page…" : "Loading page… " + progress + "%");
    }

    /** How long a run of shrinking bounds must pause before the surface takes the new size. */
    static final long RESIZE_SETTLE_MS = 150;
    private int pendingWidth = -1, pendingHeight = -1;
    private final Runnable settledResize = this::applySize;

    /**
     * Places the surface over the shell's content rectangle. Edges are rounded,
     * not the origin and size apart: rounding y and height separately can leave
     * the bottom edge a pixel short of the shell's, a seam the shell shows
     * through. Every size change makes Gecko reallocate its surface, show the
     * old frame stretched until it redraws, and the page reflow and fire resize;
     * a layout that changes each frame (the logs showed 1 px a frame) did that
     * per frame. The position follows at once, growth too so no gap opens, and a
     * shrink waits for the run to settle, overlapping the shell briefly.
     */
    void bounds(JSObject bounds, WebView shell, float density) {
        if (h.refreshSurface == null) return;
        double x = Math.max(0, bounds.optDouble("x", 0));
        double y = Math.max(0, bounds.optDouble("y", 0));
        int left = (int) Math.round(x * density);
        int top = (int) Math.round(y * density);
        int width = Math.max(0, (int) Math.round((x + Math.max(0, bounds.optDouble("width", 0))) * density) - left);
        int height = Math.max(0, (int) Math.round((y + Math.max(0, bounds.optDouble("height", 0))) * density) - top);
        h.refreshSurface.setX(Math.round(shell.getX()) + left);
        h.refreshSurface.setY(Math.round(shell.getY()) + top);
        pendingWidth = width;
        pendingHeight = height;
        h.handler.removeCallbacks(settledResize);
        ViewGroup.LayoutParams params = h.refreshSurface.getLayoutParams();
        if (width >= params.width && height >= params.height) applySize();
        else h.handler.postDelayed(settledResize, RESIZE_SETTLE_MS);
    }

    private void applySize() {
        // Fullscreen owns the layout; leaving it applies the latest bounds again.
        if (h.refreshSurface == null || pendingWidth < 0 || h.video.isFullscreen()) return;
        ViewGroup.LayoutParams params = h.refreshSurface.getLayoutParams();
        if (params.width == pendingWidth && params.height == pendingHeight) return;
        params.width = pendingWidth;
        params.height = pendingHeight;
        h.refreshSurface.setLayoutParams(params);
    }

    void cancelResize() {
        h.handler.removeCallbacks(settledResize);
        pendingWidth = pendingHeight = -1;
    }
}
