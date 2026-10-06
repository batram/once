package com.zmarn.once;

import org.mozilla.geckoview.AllowOrDeny;
import org.mozilla.geckoview.GeckoResult;
import org.mozilla.geckoview.GeckoSession;
import org.mozilla.geckoview.WebRequestError;
import static com.zmarn.once.ReadingNavigationError.describe;

/** Location, history and load-request decisions for the host's current session. */
final class ReadingNavigationDelegate implements GeckoSession.NavigationDelegate {
    private final ReadingSurfaceHost h;
    ReadingNavigationDelegate(ReadingSurfaceHost host) { h = host; }

    @Override
    public void onLocationChange(
        GeckoSession ignored,
        String url,
        java.util.List<GeckoSession.PermissionDelegate.ContentPermission> permissions,
        Boolean hasUserGesture
    ) {
        if (ignored != h.session || h.awaitingRequestedStart) return;
        h.currentUrl = url == null ? "" : url;
        if (h.isSurfaceUrl(url)) h.requestedUrl = h.currentUrl;
        h.locationChanged(h.currentUrl);
        h.committedNavigation = h.activeNavigation;
        h.event("navigationCommitted", h.activeNavigation, h.currentUrl);
        h.history(h.activeNavigation);
    }

    @Override
    public void onCanGoBack(GeckoSession ignored, boolean value) {
        if (ignored != h.session) return;
        h.canGoBack = value;
        h.history(h.activeNavigation);
    }

    @Override
    public void onCanGoForward(GeckoSession ignored, boolean value) {
        if (ignored != h.session) return;
        h.canGoForward = value;
        h.history(h.activeNavigation);
    }

    @Override
    public GeckoResult<AllowOrDeny> onLoadRequest(GeckoSession ignored, LoadRequest request) {
        if (ignored != h.session) return GeckoResult.deny();
        if (h.awaitingRequestedStart) {
            if (h.sameAddress(request.uri, h.requestedUrl)) h.requestedLoadAccepted = true;
            else if (request.isRedirect && h.requestedLoadAccepted) h.requestedUrl = request.uri;
            else if (request.isDirectNavigation) return GeckoResult.deny();
        }
        if (h.isSurfaceUrl(request.uri)) return GeckoResult.fromValue(AllowOrDeny.ALLOW);
        h.openExternal(request.uri);
        return GeckoResult.fromValue(AllowOrDeny.DENY);
    }

    @Override
    public GeckoResult<GeckoSession> onNewSession(GeckoSession ignored, String uri) {
        if (ignored != h.session) return GeckoResult.fromValue(null);
        return GeckoResult.fromValue(h.createWindow(uri));
    }

    @Override
    public GeckoResult<String> onLoadError(GeckoSession ignored, String uri, WebRequestError error) {
        if (ignored != h.session || h.awaitingRequestedStart && !uri.equals(h.requestedUrl)) return null;
        h.failed(uri, error.code, describe(error));
        h.showRecovery(describe(error) + ". Retry the page or choose another story.");
        return null;
    }
}
