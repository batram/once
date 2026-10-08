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
        if (h.bridgePort != null && h.healthSentAt == 0 && now >= h.nextHealthAt && h.isEmbeddable(h.currentUrl)) {
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

    void bounds(JSObject bounds, WebView shell, float density) {
        if (h.refreshSurface == null) return;
        int x = Math.round((float) Math.max(0, bounds.optDouble("x", 0)) * density);
        int y = Math.round((float) Math.max(0, bounds.optDouble("y", 0)) * density);
        int width = Math.round((float) Math.max(0, bounds.optDouble("width", 0)) * density);
        int height = Math.round((float) Math.max(0, bounds.optDouble("height", 0)) * density);
        ViewGroup.LayoutParams params = h.refreshSurface.getLayoutParams();
        if (params.width != width || params.height != height) {
            params.width = width;
            params.height = height;
            h.refreshSurface.setLayoutParams(params);
        }
        h.refreshSurface.setX(shell.getX() + x);
        h.refreshSurface.setY(shell.getY() + y);
    }
}
