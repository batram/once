package com.zmarn.once;

import android.content.pm.ApplicationInfo;
import android.os.Message;
import android.util.Log;
import android.view.View;
import android.webkit.ConsoleMessage;
import android.webkit.GeolocationPermissions;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebView;

/** Title, windows, fullscreen, progress and permission decisions for one page view. */
final class LiteChrome extends WebChromeClient {
    private final LiteSurfaceHost h;
    private final LiteWebView view;

    LiteChrome(LiteSurfaceHost host, LiteWebView view) { h = host; this.view = view; }

    private boolean current() { return h.surface == view; }

    @Override public void onReceivedTitle(WebView ignored, String title) {
        if (!current()) return;
        h.pageTitle = title == null ? "" : title;
        h.reportTab();
    }

    @Override public void onProgressChanged(WebView ignored, int progress) {
        if (!current() || h.navigationCompleted || h.loadStatus == null || !h.pageRequested
            || h.recoveryView != null && h.recoveryView.getVisibility() == View.VISIBLE) return;
        h.loadStatus.show(progress >= 100 ? "Displaying page…" : "Loading page… " + progress + "%");
    }

    /**
     * window.open and target=_blank: the page's new window becomes a tab of the
     * shell's. The link's address is in the hit test for a tapped link; a
     * scripted open reveals it only when the new view starts loading.
     */
    @Override public boolean onCreateWindow(WebView ignored, boolean isDialog, boolean isUserGesture, Message resultMsg) {
        if (!current()) return false;
        String url = null;
        WebView.HitTestResult hit = view.getHitTestResult();
        if (isUserGesture && hit != null && hit.getType() == WebView.HitTestResult.SRC_ANCHOR_TYPE) url = hit.getExtra();
        WebView created = h.createWindow(url);
        if (created == null) return false;
        ((WebView.WebViewTransport) resultMsg.obj).setWebView(created);
        resultMsg.sendToTarget();
        return true;
    }

    @Override public void onCloseWindow(WebView ignored) { if (current()) h.pageCloseRequested(); }

    @Override public void onShowCustomView(View custom, CustomViewCallback callback) {
        if (!current()) { callback.onCustomViewHidden(); return; }
        h.video.enter(custom, callback);
    }

    @Override public void onHideCustomView() { if (current()) h.video.fullscreen(false); }

    @Override public void onPermissionRequest(PermissionRequest request) { request.deny(); }

    @Override public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
        callback.invoke(origin, false, false);
    }

    /** Page consoles reach logcat in debuggable builds only, with secrets redacted as the shell's are. */
    @Override public boolean onConsoleMessage(ConsoleMessage message) {
        if ((view.getContext().getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) == 0) return true;
        Log.println(message.messageLevel() == ConsoleMessage.MessageLevel.ERROR ? Log.ERROR : Log.DEBUG, "OnceLitePage",
            LogRedaction.redact(message.message()) + " (" + LiteNavigation.host(message.sourceId()) + ":" + message.lineNumber() + ")");
        return true;
    }
}
