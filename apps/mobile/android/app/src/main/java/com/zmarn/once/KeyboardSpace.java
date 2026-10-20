package com.zmarn.once;

import android.content.pm.PackageInfo;
import android.util.Log;
import android.view.View;
import android.view.ViewTreeObserver;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.webkit.WebViewCompat;

/**
 * Owns the room the window keeps for the keyboard and the system bars: the
 * decor view's padding, derived from the window's current insets whenever it
 * lays out or draws, regains focus or resumes.
 *
 * Capacitor's SystemBars sets that padding from an insets listener on the
 * decor view, so it is only as current as the last dispatch that reached that
 * listener. A view holds one such listener, and GeckoView replaces it with its
 * own on every attach (and clears it on detach): from the first page view on,
 * the padding stayed whatever SystemBars set last, the keyboard's height when
 * a page view attached while the keyboard was up. A hide without a matching
 * dispatch left the same strip in Once Lite. Deriving the padding from the
 * window's insets at layout time needs neither the listener nor the dispatch,
 * so the window holds room for a keyboard exactly while one shows, however
 * the hide, the dialogs and the page views interleave.
 *
 * The padding is SystemBars' own, so the two agree whenever its dispatch is
 * current; SystemBars still decides what the shell WebView's insets say.
 */
final class KeyboardSpace {
    private static final String TAG = "KeyboardSpace";
    /** SystemBars' WebView_VERSION_WITH_SAFE_AREA_FIX: the page pads for the bars itself. */
    private static final int WEBVIEW_SAFE_AREA_FIX = 140;
    private final View decor;
    private final boolean pageOwnsBars;
    private final Runnable sync = this::sync;

    private KeyboardSpace(View decor, boolean pageOwnsBars) {
        this.decor = decor;
        this.pageOwnsBars = pageOwnsBars;
    }

    static KeyboardSpace install(View decor) {
        KeyboardSpace space = new KeyboardSpace(decor, webViewMajor(decor) >= WEBVIEW_SAFE_AREA_FIX);
        ViewTreeObserver observer = decor.getViewTreeObserver();
        observer.addOnGlobalLayoutListener(space::sync);
        observer.addOnPreDrawListener(() -> { space.sync(); return true; });
        observer.addOnWindowFocusChangeListener(focused -> space.schedule());
        return space;
    }

    /** Syncs after the current frame, once whatever is changing has laid out. */
    void schedule() {
        decor.removeCallbacks(sync);
        decor.post(sync);
    }

    private void sync() {
        WindowInsetsCompat insets = ViewCompat.getRootWindowInsets(decor);
        if (insets == null) return;
        boolean keyboard = insets.isVisible(WindowInsetsCompat.Type.ime());
        int keyboardBottom = keyboard ? insets.getInsets(WindowInsetsCompat.Type.ime()).bottom : 0;
        Insets bars = pageOwnsBars ? Insets.NONE
            : insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
        int bottom = keyboard ? keyboardBottom : bars.bottom;
        if (decor.getPaddingLeft() == bars.left && decor.getPaddingTop() == bars.top
            && decor.getPaddingRight() == bars.right && decor.getPaddingBottom() == bottom) return;
        if (!keyboard && decor.getPaddingBottom() > bottom)
            Log.d(TAG, "released " + (decor.getPaddingBottom() - bottom) + "px kept for a hidden keyboard");
        decor.setPadding(bars.left, bars.top, bars.right, bottom);
    }

    private static int webViewMajor(View view) {
        PackageInfo info = WebViewCompat.getCurrentWebViewPackage(view.getContext());
        if (info == null || info.versionName == null) return 0;
        try { return Integer.parseInt(info.versionName.split("\\.")[0]); } catch (NumberFormatException e) { return 0; }
    }
}
