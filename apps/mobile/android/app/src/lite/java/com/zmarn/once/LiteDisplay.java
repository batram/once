package com.zmarn.once;

import android.view.ViewGroup;
import android.webkit.WebView;
import com.getcapacitor.JSObject;

/** Places the page over the shell's content rectangle; see ReadingDisplay.bounds for the rounding rules. */
final class LiteDisplay {
    private final LiteSurfaceHost h;
    LiteDisplay(LiteSurfaceHost host) { h = host; }
    /** Hidden under a view of the shell's own that stays up, so the page is never shown to be verified. */
    boolean coveredByShell;

    /** How long a run of shrinking bounds must pause before the surface takes the new size. */
    static final long RESIZE_SETTLE_MS = 150;
    private int pendingWidth = -1, pendingHeight = -1;
    private final Runnable settledResize = this::applySize;

    /** The shell's setVisible; `covered`: hidden under a view of its own that stays up (a comment thread). */
    void show(boolean visible, boolean covered) {
        coveredByShell = !visible && covered;
        h.setSurfaceVisible(visible);
    }

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
