package com.zmarn.once;

import android.app.PictureInPictureParams;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Rect;
import android.os.Build;
import android.util.Log;
import android.util.Rational;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebChromeClient;
import android.widget.FrameLayout;
import androidx.activity.OnBackPressedCallback;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.JSObject;

/**
 * Presents the WebView's fullscreen video (onShowCustomView) above the shell;
 * Android PiP keeps that same player, as ReadingVideo does for Gecko. The
 * standard web PiP request path (ReadingPip) waits for the Once-owned content
 * world of M2.
 */
final class LiteVideo implements VideoPresentation {
    private final LiteSurfaceHost host;
    private FrameLayout overlay;
    private View custom;
    private WebChromeClient.CustomViewCallback callback;
    private boolean statusBar, navigationBar;
    private int barsBehavior;
    private OnBackPressedCallback back;
    private JSObject bounds;
    private boolean pip;

    LiteVideo(LiteSurfaceHost host) { this.host = host; }
    private MainActivity activity() { return (MainActivity) host.getActivity(); }
    boolean isFullscreen() { return overlay != null; }

    void bounds(JSObject value) {
        bounds = value;
        if (!isFullscreen()) applyBounds();
    }

    private void applyBounds() {
        if (bounds != null) host.display.bounds(bounds, host.getBridge().getWebView(),
            host.getContext().getResources().getDisplayMetrics().density);
    }

    /** Chromium hands over the view holding the video; it goes above everything, black behind it. */
    void enter(View view, WebChromeClient.CustomViewCallback done) {
        if (isFullscreen() || !host.visible || !host.ownsForeground() || host.refreshSurface == null) {
            done.onCustomViewHidden();
            return;
        }
        MainActivity activity = activity();
        if (activity.readingVideo != null && activity.readingVideo != this) activity.readingVideo.reset();
        activity.readingVideo = this;
        custom = view;
        callback = done;
        ViewGroup parent = (ViewGroup) host.refreshSurface.getParent();
        overlay = new FrameLayout(activity);
        overlay.setBackgroundColor(Color.BLACK);
        overlay.addView(view, new FrameLayout.LayoutParams(-1, -1));
        parent.addView(overlay, new ViewGroup.LayoutParams(-1, -1));
        host.refreshSurface.setEnabled(false);
        host.refreshSurface.setRefreshing(false);
        WindowInsetsCompat insets = ViewCompat.getRootWindowInsets(overlay);
        statusBar = insets == null || insets.isVisible(WindowInsetsCompat.Type.statusBars());
        navigationBar = insets == null || insets.isVisible(WindowInsetsCompat.Type.navigationBars());
        WindowInsetsControllerCompat bars = WindowCompat.getInsetsController(activity.getWindow(), overlay);
        barsBehavior = bars.getSystemBarsBehavior();
        bars.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        bars.hide(WindowInsetsCompat.Type.systemBars());
        back = new OnBackPressedCallback(true) {
            @Override public void handleOnBackPressed() { exit(); }
        };
        activity.getOnBackPressedDispatcher().addCallback(back);
        overlay.setKeepScreenOn(true);
        update();
    }

    /** Leaves fullscreen: from the page (onHideCustomView) or Back, which tells the page too. */
    void fullscreen(boolean enabled) {
        if (enabled || !isFullscreen()) return;
        if (pip) pipChanged(false);
        MainActivity activity = activity();
        if (activity.getPackageManager().hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)) {
            try { activity.setPictureInPictureParams(params(false)); }
            catch (IllegalArgumentException | IllegalStateException error) { Log.w(LiteSurfaceHost.TAG, "Could not disable PiP", error); }
        }
        ViewGroup parent = (ViewGroup) overlay.getParent();
        overlay.removeAllViews();
        if (parent != null) parent.removeView(overlay);
        overlay = null;
        custom = null;
        if (host.refreshSurface != null) host.refreshSurface.setEnabled(true);
        applyBounds();
        if (back != null) { back.remove(); back = null; }
        if (parent != null) {
            WindowInsetsControllerCompat bars = WindowCompat.getInsetsController(activity.getWindow(), parent);
            bars.setSystemBarsBehavior(barsBehavior);
            if (statusBar) bars.show(WindowInsetsCompat.Type.statusBars());
            if (navigationBar) bars.show(WindowInsetsCompat.Type.navigationBars());
        }
        if (activity.readingVideo == this) activity.readingVideo = null;
        WebChromeClient.CustomViewCallback done = callback;
        callback = null;
        if (done != null) done.onCustomViewHidden();
    }

    void exit() { fullscreen(false); }

    @Override public void reset() {
        if (isFullscreen()) exit();
        bounds = null;
    }

    boolean canPip() {
        return isFullscreen() && host.visible && host.ownsForeground() && host.backgroundMedia != null
            && host.backgroundMedia.state.playing && aspect() != null
            && activity().getPackageManager().hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE);
    }

    /** The video's shape, from the page's media report, else the presented view's. */
    private Rational aspect() {
        int width = 0, height = 0;
        if (host.backgroundMedia != null) { width = host.backgroundMedia.videoWidth; height = host.backgroundMedia.videoHeight; }
        if ((width <= 0 || height <= 0) && custom != null) { width = custom.getWidth(); height = custom.getHeight(); }
        if (width <= 0 || height <= 0) return null;
        // Android accepts ratios between 1:2.39 and 2.39:1, including portrait video.
        return new Rational((int) Math.max(4185, Math.min(23900, Math.round((double) width / height * 10000))), 10000);
    }

    private PictureInPictureParams params(boolean enabled) {
        PictureInPictureParams.Builder builder = new PictureInPictureParams.Builder();
        Rational ratio = aspect();
        if (ratio != null) builder.setAspectRatio(ratio);
        Rect rect = new Rect();
        if (custom != null && custom.getGlobalVisibleRect(rect)) builder.setSourceRectHint(rect);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) builder.setAutoEnterEnabled(enabled);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) builder.setSeamlessResizeEnabled(false);
        return builder.build();
    }

    /** Playback changed: PiP eligibility follows it. */
    void update() {
        if (isFullscreen() && host.backgroundMedia != null) overlay.setKeepScreenOn(host.backgroundMedia.state.playing);
        if (activity().readingVideo != this) return;
        if (activity().getPackageManager().hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)) {
            try { activity().setPictureInPictureParams(params(canPip())); }
            catch (IllegalArgumentException | IllegalStateException error) { Log.w(LiteSurfaceHost.TAG, "Could not update PiP", error); }
        }
    }

    @Override public void leave() {
        // Android 12+ auto-entry handles gesture navigation and button navigation.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S || !canPip()) return;
        try { activity().enterPictureInPictureMode(params(true)); }
        catch (IllegalArgumentException | IllegalStateException error) { Log.w(LiteSurfaceHost.TAG, "Could not enter PiP", error); }
    }

    @Override public void pipChanged(boolean enabled) {
        if (pip == enabled) return;
        pip = enabled;
        if (host.backgroundMedia != null) host.backgroundMedia.setPictureInPicture(enabled);
        if (!enabled) update();
    }
}
