package com.zmarn.once;

import android.app.PictureInPictureParams;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Rect;
import android.os.Build;
import android.util.Log;
import android.util.Rational;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import androidx.activity.OnBackPressedCallback;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.JSObject;
import org.mozilla.geckoview.MediaSession;
import org.mozilla.gecko.GeckoThread;

/** Presents Gecko fullscreen content above the shell; Android PiP keeps that same player. */
final class ReadingVideo implements VideoPresentation {
    private final ReadingSurfaceHost host;
    private FrameLayout overlay;
    private ViewGroup parent;
    private ViewGroup.LayoutParams layout;
    private int index;
    private int width, height;
    private float x, y;
    private boolean statusBar, navigationBar;
    private int barsBehavior;
    private OnBackPressedCallback back;
    private JSObject bounds;
    private boolean pip;
    private MediaSession.ElementMetadata videoMetadata;
    final ReadingPip api;

    ReadingVideo(ReadingSurfaceHost host) { this.host = host; api = new ReadingPip(this, host); }
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

    void fullscreen(boolean enabled) {
        // A site exiting DOM fullscreen must not dismantle native API PiP.
        if (!enabled && pip && api.direct) return;
        if (enabled == isFullscreen()) return;
        if (enabled) {
            if (!host.visible || !host.ownsForeground() || host.refreshSurface == null) {
                if (host.session != null) host.session.exitFullScreen();
                return;
            }
            MainActivity activity = activity();
            if (activity.readingVideo != null && activity.readingVideo != this) activity.readingVideo.reset();
            activity.readingVideo = this;
            parent = (ViewGroup) host.refreshSurface.getParent();
            index = parent.indexOfChild(host.refreshSurface);
            layout = host.refreshSurface.getLayoutParams();
            width = layout.width; height = layout.height;
            x = host.refreshSurface.getX(); y = host.refreshSurface.getY();
            overlay = new FrameLayout(activity);
            overlay.setBackgroundColor(Color.BLACK);
            host.refreshSurface.addOnLayoutChangeListener(resized);
            host.refreshSurface.setX(0); host.refreshSurface.setY(0);
            host.refreshSurface.setEnabled(false);
            host.refreshSurface.setRefreshing(false);
            // Keep Gecko attached and focused throughout its fullscreen handshake.
            // Reparenting it here makes Gecko reject the pending DOM request.
            parent.addView(overlay, index, new ViewGroup.LayoutParams(-1, -1));
            layout.width = -1; layout.height = -1;
            host.refreshSurface.setLayoutParams(layout);
            host.refreshSurface.bringToFront();
            host.surface.requestFocus();
            host.session.setFocused(true);
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
            // Presentation owns removal and retains Back while paused in PiP.
            activity.getOnBackPressedDispatcher().addCallback(back);
        } else {
            if (pip) pipChanged(false);
            if (activity().getPackageManager().hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)) {
                try { activity().setPictureInPictureParams(params(false)); }
                catch (IllegalArgumentException | IllegalStateException error) { Log.w(ReadingSurfaceHost.TAG, "Could not disable PiP", error); }
            }
            host.refreshSurface.setKeepScreenOn(false);
            ((ViewGroup) overlay.getParent()).removeView(overlay);
            overlay = null;
            videoMetadata = null;
            host.refreshSurface.removeOnLayoutChangeListener(resized);
            layout.width = width; layout.height = height;
            host.refreshSurface.setLayoutParams(layout);
            host.refreshSurface.setX(x); host.refreshSurface.setY(y);
            // Restore sibling order without detaching the live player on Back.
            int above = parent.getChildCount() - 1 - index;
            for (int i = 0; i < above; i++) parent.getChildAt(index).bringToFront();
            host.surface.requestFocus();
            if (host.session != null && host.visible) host.session.setFocused(true);
            host.refreshSurface.setEnabled(true);
            applyBounds();
            back.remove(); back = null;
            WindowInsetsControllerCompat bars = WindowCompat.getInsetsController(activity().getWindow(), parent);
            bars.setSystemBarsBehavior(barsBehavior);
            if (statusBar) bars.show(WindowInsetsCompat.Type.statusBars());
            if (navigationBar) bars.show(WindowInsetsCompat.Type.navigationBars());
            if (activity().readingVideo == this) activity().readingVideo = null;
        }
        update();
    }

    private final android.view.View.OnLayoutChangeListener resized = (view, l, t, r, b, ol, ot, or, ob) -> {
        surfaceResized();
    };

    private void surfaceResized() { update(); api.resized(pip); }

    void exit() {
        if (host.session != null && host.session.isOpen()) host.session.exitFullScreen();
        fullscreen(false);
    }

    @Override public void reset() {
        api.cancel();
        api.direct = false;
        if (isFullscreen()) exit();
        bounds = null;
    }

    boolean canPip() {
        MediaSession.ElementMetadata video = metadata();
        return isFullscreen() && host.visible && host.ownsForeground() && host.session != null && host.session.isOpen()
            && host.backgroundMedia.state.playing && video != null && video.width > 0 && video.height > 0
            && activity().getPackageManager().hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE);
    }

    private PictureInPictureParams params(boolean enabled) {
        PictureInPictureParams.Builder builder = new PictureInPictureParams.Builder();
        MediaSession.ElementMetadata video = metadata();
        if (api.direct && api.width > 0 && api.height > 0) {
            builder.setAspectRatio(ratio(api.width, api.height));
        } else if (video != null && video.width > 0 && video.height > 0) {
            // Android accepts ratios between 1:2.39 and 2.39:1, including portrait video.
            int width = (int) Math.max(4185, Math.min(23900, Math.round((double) video.width / video.height * 10000)));
            builder.setAspectRatio(new Rational(width, 10000));
        }
        Rect rect = new Rect();
        if (host.surface != null && host.surface.getGlobalVisibleRect(rect)) builder.setSourceRectHint(rect);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) builder.setAutoEnterEnabled(enabled);
        // Gecko's SurfaceView replaces its buffers when the window resizes;
        // Android's cross-fade covers that handoff instead of exposing black.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) builder.setSeamlessResizeEnabled(false);
        return builder.build();
    }

    private Rational ratio(int width, int height) {
        return new Rational((int) Math.max(4185, Math.min(23900, Math.round((double) width / height * 10000))), 10000);
    }

    boolean enterPip(Rect source) {
        PictureInPictureParams.Builder builder = new PictureInPictureParams.Builder().setAspectRatio(ratio(api.width, api.height));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) builder.setSeamlessResizeEnabled(false);
        if (source != null) builder.setSourceRectHint(source);
        return activity().enterPictureInPictureMode(builder.build());
    }

    void update() {
        // Gecko can deactivate its media session while a paused video stays
        // in DOM fullscreen. Its presentation still owns these dimensions;
        // keep them until fullscreen exits so resuming can enter PiP again.
        if (isFullscreen() && host.backgroundMedia.fullscreenVideo != null) videoMetadata = host.backgroundMedia.fullscreenVideo;
        if (isFullscreen()) host.refreshSurface.setKeepScreenOn(host.backgroundMedia.state.playing);
        if (activity().readingVideo != this) return;
        if (activity().getPackageManager().hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)) {
            try { activity().setPictureInPictureParams(params(canPip())); }
            catch (IllegalArgumentException | IllegalStateException error) { Log.w(ReadingSurfaceHost.TAG, "Could not update PiP", error); }
        }
    }

    @Override public void leave() {
        Log.d("OnceVideo", "Leaving fullscreen: PiP eligible=" + canPip() + " playing=" + host.backgroundMedia.state.playing);
        // Android 12+ auto-entry handles gesture navigation and button navigation.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S || !canPip()) return;
        try { activity().enterPictureInPictureMode(params(true)); }
        catch (IllegalArgumentException | IllegalStateException error) { Log.w(ReadingSurfaceHost.TAG, "Could not enter PiP", error); }
    }

    @Override public void pipChanged(boolean enabled) {
        if (pip == enabled) return;
        if (enabled && api.direct) fullscreen(true);
        Log.d("OnceVideo", "PiP mode=" + enabled);
        pip = enabled;
        // GeckoRuntime pauses on ProcessLifecycleOwner.ON_PAUSE, including
        // visible Android PiP. Balance that pause for this presentation so its
        // GPU service is not demoted to cached and killed during playback.
        // Gecko's native pause counter permits overlapping visibility owners.
        if (enabled) GeckoThread.onResume();
        else GeckoThread.onPause();
        host.backgroundMedia.setPictureInPicture(enabled);
        if (host.session != null) host.session.getCompositorController().onPipModeChanged(enabled);
        api.state(enabled);
        if (!enabled && api.direct) {
            api.direct = false;
            exit();
        }
        if (!enabled) update();
    }

    private MediaSession.ElementMetadata metadata() {
        return host.backgroundMedia.fullscreenVideo != null ? host.backgroundMedia.fullscreenVideo : videoMetadata;
    }
}
