package com.zmarn.once;

import android.os.Handler;
import android.os.Looper;
import android.webkit.WebView;

/** A long-press on a link or image: the WebView hit-tests it and Once draws the menu. */
final class LiteContextMenu {
    private LiteContextMenu() {}

    /** True when the press hit a link or image and the menu takes it; false leaves text selection to the view. */
    static boolean longPressed(LiteSurfaceHost host, LiteWebView view) {
        WebView.HitTestResult hit = view.getHitTestResult();
        if (hit == null) return false;
        int type = hit.getType();
        boolean anchor = type == WebView.HitTestResult.SRC_ANCHOR_TYPE || type == WebView.HitTestResult.SRC_IMAGE_ANCHOR_TYPE;
        boolean image = type == WebView.HitTestResult.IMAGE_TYPE || type == WebView.HitTestResult.SRC_IMAGE_ANCHOR_TYPE;
        if (!anchor && !image) return false;
        String extra = hit.getExtra();
        // The hit test names one address; the focused node has the link, its text and the image.
        view.requestFocusNodeHref(new Handler(Looper.getMainLooper(), message -> {
            if (host.surface != view) return true;
            String link = message.getData().getString("url");
            String text = message.getData().getString("title");
            String src = message.getData().getString("src");
            if (anchor && (link == null || link.isEmpty())) link = type == WebView.HitTestResult.SRC_ANCHOR_TYPE ? extra : null;
            if (image && (src == null || src.isEmpty())) src = extra;
            if (!anchor) link = null;
            if (!image) src = null;
            if (link == null && src == null) return true;
            host.showPageContextMenu(new LinkContextMenu.Target(link, text, src,
                src == null ? LinkContextMenu.Target.TYPE_NONE : LinkContextMenu.Target.TYPE_IMAGE, host.currentUrl, true));
            return true;
        }).obtainMessage());
        return true;
    }
}
