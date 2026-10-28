package com.zmarn.once;

import android.graphics.Bitmap;
import android.net.Uri;
import android.net.http.SslError;
import android.util.Log;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.SslErrorHandler;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import java.util.Collections;

/**
 * Location, history, load-request and error decisions for one page view, as
 * the GeckoView host's navigation, progress and content delegates make them.
 */
final class LiteNavigation extends WebViewClient {
    private final LiteSurfaceHost h;
    private final LiteWebView view;
    /** Whether the current document's commit was reported; a pushState reports again. */
    private boolean committed;

    LiteNavigation(LiteSurfaceHost host, LiteWebView view) { h = host; this.view = view; }

    private boolean current() { return h.surface == view; }

    /** The reading settings every page view gets; the desktop choice is per tab. */
    static void configure(LiteWebView view, boolean desktop) {
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setSupportMultipleWindows(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setBuiltInZoomControls(true);
        settings.setDisplayZoomControls(false);
        settings.setGeolocationEnabled(false);
        applyDesktopSite(view, desktop);
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            // The DevTools client tells this view's target from the others by it.
            WebViewCompat.addDocumentStartJavaScript(view,
                "try { Object.defineProperty(window, \"__onceLiteTab\", { value: " + org.json.JSONObject.quote(view.marker) + ", writable: false, configurable: false }); } catch (error) {}", Collections.singleton("*"));
        }
    }

    /** Chrome's desktop user agent in place of the mobile one; the layout viewport follows the UA. */
    static void applyDesktopSite(WebView view, boolean enabled) {
        if (view == null) return;
        WebSettings settings = view.getSettings();
        String mobile = WebSettings.getDefaultUserAgent(view.getContext());
        settings.setUserAgentString(enabled ? desktopUserAgent(mobile) : mobile);
    }

    static String desktopUserAgent(String mobile) {
        return mobile.replaceFirst("\\(Linux; Android [^)]*\\)", "(X11; Linux x86_64)").replace(" Mobile Safari", " Safari");
    }

    @Override
    public boolean shouldOverrideUrlLoading(WebView ignored, WebResourceRequest request) {
        if (!current()) return true;
        String url = request.getUrl().toString();
        if (LiteExtensionPages.isExtensionUrl(url) && h.engine().tier2Active()) {
            if (request.isForMainFrame()) h.extensionPageRefused(url);
            return true;
        }
        if (ReadingAddress.surface(url) || LiteExtensionPages.isExtensionUrl(url)) {
            // A download listener hears nothing of the gesture; a redirect hop inherits the first request's.
            if (request.isForMainFrame() && !request.isRedirect()) h.loadRequestGesture = request.hasGesture();
            return false;
        }
        // A frame may not leave for another app at all.
        if (!request.isForMainFrame()) return true;
        // A tapped link may leave for its app; a redirect or script may not
        // without asking, and must not leave a loading page blank.
        if (request.hasGesture() && !request.isRedirect()) h.openExternal(url);
        else if (!h.navigationCompleted) h.offerExternal(url);
        return true;
    }

    /**
     * Tier 2 (no DevTools): the rules the broker compiled, judged by Java
     * (LiteTier2). With DevTools the Fetch domain sees every request instead.
     */
    @Override
    public WebResourceResponse shouldInterceptRequest(WebView ignored, WebResourceRequest request) {
        com.zmarn.once.lite.LiteExtensionEngine engine = com.zmarn.once.lite.LiteExtensionEngine.current();
        if (engine == null || !engine.tier2Active()) return null;
        try { return engine.tier2().intercept(view, request); }
        catch (RuntimeException error) {
            // A response WebView refuses must not take the app down; the request goes on unfiltered.
            android.util.Log.w(LiteSurfaceHost.TAG, "Tier 2 could not judge a request", error);
            return null;
        }
    }

    @Override
    public void onPageStarted(WebView ignored, String url, Bitmap favicon) {
        if (!current() || com.zmarn.once.lite.LiteTargets.isMarkerUrl(url)) return;
        committed = false;
        h.pageStarted(url);
    }

    /** Fires on every commit, same-document ones included, as Gecko's onLocationChange. */
    @Override
    public void doUpdateVisitedHistory(WebView ignored, String url, boolean isReload) {
        if (!current() || com.zmarn.once.lite.LiteTargets.isMarkerUrl(url)) return;
        committed = true;
        com.zmarn.once.lite.LiteExtensionEngine engine = com.zmarn.once.lite.LiteExtensionEngine.current();
        if (engine != null && engine.tier2Active()) engine.tier2().committed(view, url);
        h.pageCommitted(url);
    }

    @Override
    public void onPageCommitVisible(WebView ignored, String url) {
        if (!current() || committed || com.zmarn.once.lite.LiteTargets.isMarkerUrl(url)) return;
        committed = true;
        h.pageCommitted(url);
    }

    @Override
    public void onPageFinished(WebView ignored, String url) {
        if (!current() || com.zmarn.once.lite.LiteTargets.isMarkerUrl(url)) return;
        h.finishRefresh();
        h.documentReady();
    }

    @Override
    public void onReceivedError(WebView ignored, WebResourceRequest request, WebResourceError error) {
        if (!current() || !request.isForMainFrame()) return;
        String url = request.getUrl().toString();
        // A custom scheme the page redirected to was already offered as an app link.
        if (error.getErrorCode() == ERROR_UNSUPPORTED_SCHEME && h.offeredExternalUrl != null) return;
        String message = describe(error.getErrorCode());
        h.failed(url, error.getErrorCode(), message);
        h.showRecovery(message + ". Retry the page or choose another story.");
    }

    @Override
    public void onReceivedHttpError(WebView ignored, WebResourceRequest request, WebResourceResponse response) {
        if (!current() || !request.isForMainFrame()) return;
        h.documentStatus = response.getStatusCode();
    }

    @Override
    public void onReceivedSslError(WebView ignored, SslErrorHandler handler, SslError error) {
        handler.cancel();
        if (!current()) return;
        String url = error.getUrl() == null ? h.currentUrl : error.getUrl();
        h.failed(url, ERROR_FAILED_SSL_HANDSHAKE, "TLS certificate validation failed");
        h.showRecovery("TLS certificate validation failed. Retry the page or choose another story.");
    }

    /** The renderer went away; claim the loss and rebuild, bounded, instead of ending the app. */
    @Override
    public boolean onRenderProcessGone(WebView ignored, RenderProcessGoneDetail detail) {
        if (!current()) { ignored.destroy(); return true; }
        String reason = detail.didCrash() ? "The page process crashed" : "The page process was stopped";
        Log.w(LiteSurfaceHost.TAG, reason + "; priority at exit " + detail.rendererPriorityAtExit());
        if (h.visible && h.resumed) h.recoverPage(reason);
        else { h.releaseView(); h.killedWhileHidden = true; }
        return true;
    }

    static String describe(int code) {
        switch (code) {
            case ERROR_FAILED_SSL_HANDSHAKE: return "TLS certificate validation failed";
            case ERROR_HOST_LOOKUP: case ERROR_BAD_URL: case ERROR_UNSUPPORTED_SCHEME: return "The address could not be resolved";
            case ERROR_CONNECT: case ERROR_TIMEOUT: case ERROR_IO: case ERROR_PROXY_AUTHENTICATION:
            case ERROR_REDIRECT_LOOP: case ERROR_TOO_MANY_REQUESTS: case ERROR_UNSAFE_RESOURCE: return "The network request failed";
            case ERROR_FILE: case ERROR_FILE_NOT_FOUND: case ERROR_UNSUPPORTED_AUTH_SCHEME: return "The content could not be loaded";
            default: return "The page could not be loaded";
        }
    }

    /** Shortens a URL for logs. */
    static String host(String url) {
        String host = Uri.parse(url).getHost();
        return host == null ? "" : host;
    }
}
