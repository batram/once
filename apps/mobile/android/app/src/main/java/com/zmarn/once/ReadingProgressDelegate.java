package com.zmarn.once;

import android.util.Log;
import org.mozilla.geckoview.GeckoSession;

/** Page start/stop and session-state tracking for the host's current session. */
final class ReadingProgressDelegate implements GeckoSession.ProgressDelegate {
    private final ReadingSurfaceHost h;
    ReadingProgressDelegate(ReadingSurfaceHost host) { h = host; }

    @Override public void onProgressChange(GeckoSession source, int progress) { h.display.progress(source, progress); }
    @Override public void onSessionStateChange(GeckoSession source, GeckoSession.SessionState state) {
        // An empty snapshot must not replace the last one that could restore the page.
        if (source == h.session && !h.awaitingRequestedStart && !h.initialBlank && state != null && !state.isEmpty())
            h.sessionState = state;
        if (source == h.session && state != null) h.historyListChanged(state);
    }
    @Override
    public void onPageStart(GeckoSession ignored, String url) {
        if (ignored != h.session) return;
        if (h.awaitingRequestedStart && !ReadingAddress.same(h.requestedUrl, url)) return;
        h.awaitingRequestedStart = false;
        h.offeredExternalUrl = null;
        h.painted = false;
        h.documentPainted = false;
        h.repairVerified = false;
        h.displayReattached = false;
        h.backgroundMedia.reset();
        h.attachMediaPort(null);
        // A new session loads about:blank on its own before the first
        // requested page; the shell never asked for that one.
        h.failPendingEvaluations("The page navigated away");
        h.bridgePort = null;
        h.healthSentAt = 0;
        h.scrollY = 0;
        h.initialBlank = !h.sawRequestedPage && "about:blank".equals(url);
        if (!h.initialBlank) h.sawRequestedPage = true;
        h.activeNavigation = h.navigationSequence.incrementAndGet();
        h.currentUrl = url == null ? "" : url;
        h.pageTitle = "";
        h.documentSourceUrl = h.currentUrl;
        h.documentStatus = 0;
        if (!h.initialBlank && ReadingAddress.surface(h.currentUrl)) { h.requestedUrl = h.currentUrl; h.armNavigation(); }
        if (!h.initialBlank) h.traceLoad("started");
        h.event("navigationStarted", h.activeNavigation, h.currentUrl);
    }

    @Override
    public void onPageStop(GeckoSession ignored, boolean success) {
        if (ignored != h.session || h.awaitingRequestedStart) return;
        h.finishRefresh();
        // stop() also produces an unsuccessful PageStop. Do not let a
        // superseded load cover the next document with an error. Real load
        // errors arrive in onLoadError; missing completion stays bounded.
        if (!success) return;
        // A new session's own about:blank is not the requested page. Completing
        // on it cleared the navigation deadline, so a restore that then never
        // loaded (its process killed under memory pressure) stayed blank forever.
        if (h.initialBlank) return;
        // Only a background tab skips verification; a selected tab hidden
        // under a dialog or panel is verified once it is shown again.
        if (!h.visible && !h.ownsForeground()) { h.documentReady(); return; }
        if (!ReadingAddress.embeddable(h.currentUrl)) h.navigationDeadline = 0;
        // A successful network stop does not mean a visible, responsive
        // document. The matching content-port health reply completes web
        // navigation, including BFCache restores and stalled subresources.
        if (!ReadingAddress.embeddable(h.currentUrl)) h.documentReady();
        else if (!h.navigationCompleted) completeIfPdfViewer();
        h.nextHealthAt = 0;
        if (!h.initialBlank) {
            if (h.loadStatus != null && !h.navigationCompleted && h.offeredExternalUrl == null)
                h.loadStatus.show("Displaying page…");
            h.traceLoad("network-stopped");
            h.requestHealthCheck();
        }
    }

    /**
     * An http(s) PDF renders in Gecko's privileged pdf.js viewer, where the
     * content-script bridge never connects, so no health reply can finish
     * the navigation. Treat a stopped PDF load as ready, as for other
     * documents the bridge cannot reach.
     */
    private void completeIfPdfViewer() {
        GeckoSession loaded = h.session;
        long navigation = h.activeNavigation;
        loaded.isPdfJs().accept(pdf -> {
            if (loaded != h.session || navigation != h.activeNavigation || h.destroyed) return;
            h.traceLoad(Boolean.TRUE.equals(pdf) ? "pdf-viewer" : "not-pdf-viewer");
            if (!Boolean.TRUE.equals(pdf)) return;
            h.documentReady();
        }, error -> Log.w(ReadingSurfaceHost.TAG, "isPdfJs failed: " + error));
    }
}
