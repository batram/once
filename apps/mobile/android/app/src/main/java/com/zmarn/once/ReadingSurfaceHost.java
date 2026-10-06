package com.zmarn.once;

import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.content.ComponentCallbacks2;
import android.content.Intent;
import android.net.Uri;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Button;
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;
import org.mozilla.geckoview.GeckoSession;
import org.mozilla.geckoview.GeckoView;
import org.mozilla.geckoview.WebExtension;

/** Native reading session, view ownership, navigation and bounded recovery.
 * The Capacitor adapter supplies extension messaging and script-call settlement. */
abstract class ReadingSurfaceHost extends Plugin {
    protected static final String TAG = "OnceSurface";
    protected GeckoEngine engine;
    protected GeckoExtensionManager extensions;
    protected BackgroundMedia backgroundMedia;
    protected final Handler handler = new Handler(Looper.getMainLooper());
    protected boolean destroyed;
    protected boolean resumed = true;
    protected boolean visible;
    protected boolean killedWhileHidden;
    protected long surfaceGeneration;
    protected final AtomicLong requestedSequence = new AtomicLong();
    protected PluginCall navigationWaiter;
    protected String requestedUrl = "";
    protected boolean awaitingRequestedStart;
    protected boolean requestedLoadAccepted;
    protected long navigationDeadline;
    protected long healthSentAt;
    protected long healthId;
    protected long nextHealthAt;
    protected boolean painted;
    protected boolean documentPainted;
    protected boolean repairVerified;
    protected boolean navigationCompleted;
    protected boolean displayReattached;
    protected long loadStartedAt;
    protected ReadingLoadStatus loadStatus;
    protected long blankSince;
    protected boolean blankWarning;
    protected boolean recoveryFailed;
    protected int recoveryAttempts;
    protected boolean rebuilding;
    protected long recoveryGeneration;
    protected GeckoSession.SessionState sessionState;
    protected GeckoSession.SessionState hiddenState;
    protected final Runnable watchdog = this::checkHealth;
    protected static final long NAVIGATION_TIMEOUT_MS = 30000;
    protected static final long RESPONSE_TIMEOUT_MS = 12000;
    protected final Map<PluginCall, Runnable> waiting = new HashMap<>();

    protected GeckoView surface;
    protected GeckoSession session;
    protected SwipeRefreshLayout refreshSurface;
    protected LinearLayout recoveryView;
    protected TextView recoveryMessage;
    protected final AtomicLong navigationSequence = new AtomicLong();
    protected long activeNavigation;
    protected long committedNavigation;
    protected String currentUrl = "";
    protected String pageTitle = "";
    protected String documentSourceUrl = "";
    protected int documentStatus;
    protected boolean canGoBack;
    protected boolean canGoForward;
    /**
     * Gecko's history list, so the shell can keep its Reader-mode entries in
     * step. Gecko reports it only with session-store snapshots, seconds after a
     * load, so the list follows locations and this host's own moves at once;
     * a snapshot that agrees with the current page then corrects it.
     */
    protected java.util.List<String> historyUrls = new java.util.ArrayList<>();
    protected int historyIndex = -1;
    /** The position a move this host asked Gecko for lands on. */
    protected int pendingHistoryIndex = -1;
    protected int scrollY;

    /** Set once the shell asked for a page; the session's initial about:blank is not one. */
    protected boolean pageRequested;
    /** True while the session's own about:blank is loading, before any requested page. */
    protected boolean initialBlank;
    protected boolean sawRequestedPage;

    protected WebExtension.Port bridgePort;
    protected WebExtension.Port settingsPort;

    // Pause alone keeps the page active: dialogs, share sheets and screenshots pause
    // the activity while it stays visible, and an inactive session drops its process
    // into the cached bucket the low-memory killer empties first.
    @Override
    protected void handleOnStop() {
        resumed = false;
        pauseWatchdog();
        if (session != null) session.setPriorityHint(GeckoSession.PRIORITY_DEFAULT);
        if (backgroundMedia != null) backgroundMedia.setActive(false);
        if (extensions != null) extensions.pages.setResumed(false);
    }

    @Override
    protected void handleOnResume() {
        resumed = true;
        displayReattached = false;
        if (navigationDeadline != 0) navigationDeadline = SystemClock.elapsedRealtime() + NAVIGATION_TIMEOUT_MS;
        if (session != null) session.setPriorityHint(visible ? GeckoSession.PRIORITY_HIGH : GeckoSession.PRIORITY_DEFAULT);
        if (backgroundMedia != null) backgroundMedia.setActive(visible);
        if (extensions != null) extensions.pages.setResumed(true);
        recoverKilledPage();
        attachDisplay();
        resumeWatchdog();
    }

    /**
     * A process the system reclaimed while the page was hidden comes back silently.
     * Gecko closes the session of a killed process, so the recovery reopens it
     * and loads the page again rather than reloading a session that is gone.
     */
    protected void recoverKilledPage() {
        if (!killedWhileHidden || !pageRequested || !visible || !resumed) return;
        killedWhileHidden = false;
        reloadSession();
    }

    /** Android can reclaim hidden browsing state without keeping a renderer pinned. */
    void trimMemory(int level) {
        boolean pressure = level == ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW ||
            level == ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL || level >= ComponentCallbacks2.TRIM_MEMORY_BACKGROUND;
        if (!pressure) return;
        if (extensions != null) extensions.pages.trimHidden();
        if (session == null || visible && resumed || backgroundMedia.keepsPlaying()) return;
        hiddenState = sessionState;
        releaseReadingSession();
        killedWhileHidden = true;
        Log.i(TAG, "Released hidden reading session under memory pressure");
    }

    @Override
    protected void handleOnDestroy() {
        destroyed = true;
        destroySurface();
        if (extensions != null) extensions.destroy();
        if (settingsPort != null) settingsPort.disconnect();
        settingsPort = null;
        handler.removeCallbacksAndMessages(null);
    }

    protected void reloadSession() {
        // An explicit retry also applies while the old renderer is being
        // replaced; do not discard it and inherit the exhausted retry budget.
        requestedSequence.incrementAndGet();
        recoveryAttempts = 0;
        if (rebuilding) return;
        if (session == null) {
            if (!pageRequested || surface == null) return;
            GeckoSession.SessionState restore = hiddenState;
            hiddenState = null;
            createReadingSession();
            armNavigation();
            if (restore != null) session.restoreState(restore);
            else session.loadUri(recoveryUrl());
            return;
        }
        if (recoveryFailed || healthSentAt != 0 && SystemClock.elapsedRealtime() - healthSentAt >= RESPONSE_TIMEOUT_MS) {
            recoverPage("Restarting the page", true);
            return;
        }
        if (!session.isOpen()) {
            reopenSession();
            extensions.foregroundChanged();
            if (pageRequested && isSurfaceUrl(recoveryUrl())) {
                armNavigation(); session.loadUri(recoveryUrl());
            }
        } else { armNavigation(); session.reload(); }
    }

    /**
     * Gecko closes a session whose process died. Reopening it makes a new window,
     * and the view only paints that window once it is attached again; without the
     * re-attach the page loads, answers scripts and stays blank on screen.
     */
    protected void reopenSession() {
        releaseReadingSession();
        createReadingSession();
    }

    protected void ensureSurface() {
        if (surface != null) {
            if (rebuilding) return;
            if (!recoveryFailed && (session == null || !session.isOpen())) reopenSession();
            return;
        }
        if (session == null || !session.isOpen()) createReadingSession();

        surface = new GeckoView(getContext());
        // The extension bootstrap needs a session, not a 1x1 display. Attach
        // only after the shell's real viewport has been laid out and exposed.
        surface.addOnLayoutChangeListener((view, l, t, r, b, ol, ot, or, ob) -> attachDisplay());

        FrameLayout content = new FrameLayout(getContext());
        content.addView(surface, new FrameLayout.LayoutParams(-1, -1));
        recoveryView = new LinearLayout(getContext());
        recoveryView.setOrientation(LinearLayout.VERTICAL);
        recoveryView.setGravity(android.view.Gravity.CENTER);
        recoveryView.setBackgroundColor(android.graphics.Color.rgb(247, 246, 251));
        int padding = Math.round(24 * getContext().getResources().getDisplayMetrics().density);
        recoveryView.setPadding(padding, padding, padding, padding);
        recoveryMessage = new TextView(getContext());
        recoveryMessage.setTextColor(android.graphics.Color.rgb(40, 40, 45));
        recoveryMessage.setTextSize(18);
        recoveryView.addView(recoveryMessage);
        Button retry = new Button(getContext());
        retry.setText("Retry page");
        retry.setOnClickListener(ignored -> reloadSession());
        recoveryView.addView(retry);
        recoveryView.setVisibility(View.GONE);
        content.addView(recoveryView, new FrameLayout.LayoutParams(-1, -1));
        loadStatus = new ReadingLoadStatus(getContext());
        content.addView(loadStatus, loadStatus.layoutParams());

        refreshSurface = new SwipeRefreshLayout(getContext());
        refreshSurface.setVisibility(visible ? View.VISIBLE : View.INVISIBLE);
        refreshSurface.addView(content, new ViewGroup.LayoutParams(-1, -1));
        refreshSurface.setOnChildScrollUpCallback((parent, child) -> scrollY > 0);
        refreshSurface.setOnRefreshListener(this::reloadSession);
        WebView shell = getBridge().getWebView();
        ViewGroup parent = (ViewGroup) shell.getParent();
        int shellIndex = parent.indexOfChild(shell);
        parent.addView(refreshSurface, shellIndex + 1, new ViewGroup.LayoutParams(1, 1));
    }

    protected void createReadingSession() { createReadingSession(true); }

    protected void createReadingSession(boolean open) {
        GeckoSession created = new GeckoSession();
        session = created;
        sessionState = null;
        backgroundMedia.playingChanged = playing -> notifyListeners("mediaStateChanged", new JSObject().put("playing", playing));
        backgroundMedia.attach(created);
        // The reading page is the selected tab: keep its process bound above the
        // cached-app bucket so the low-memory killer takes other things first.
        session.setPriorityHint(visible && resumed ? GeckoSession.PRIORITY_HIGH : GeckoSession.PRIORITY_DEFAULT);
        session.setNavigationDelegate(new ReadingNavigationDelegate(this));
        session.setProgressDelegate(new ReadingProgressDelegate(this));
        session.setContentDelegate(new ReadingContentDelegate(url -> { if (session == created) openExternal(url); },
            message -> { if (session == created) processStopped(message); },
            () -> visible && resumed, () -> {
                if (session != created) return;
                forgetPageState("The page process was stopped while hidden");
                killedWhileHidden = true;
            }, () -> display.painted(created), () -> display.resetPaint(created), filename -> {
                if (session != created) return;
                Log.w(TAG, "Slow script: " + filename);
                if (navigationDeadline == 0) navigationDeadline = SystemClock.elapsedRealtime() + RESPONSE_TIMEOUT_MS;
                resumeWatchdog();
            }, title -> { if (session == created) pageTitle = title; },
            () -> { if (session == created) pageCloseRequested(); },
            element -> { if (session == created) showContextMenu(element); }));
        session.setHistoryDelegate(new GeckoSession.HistoryDelegate() {
            @Override
            public void onHistoryStateChange(GeckoSession source, GeckoSession.HistoryDelegate.HistoryList list) {
                if (source == session) historyListChanged(list);
            }
        });
        session.setScrollDelegate(new GeckoSession.ScrollDelegate() {
            @Override
            public void onScrollChanged(GeckoSession ignored, int x, int y) {
                if (ignored != session) return;
                scrollY = y;
            }
        });
        if (open) session.open(engine.runtime);
        extensions.attachSession(session);
        attachBridge();
        attachDisplay();
        backgroundMedia.setActive(visible && resumed);
    }

    protected final ReadingDisplay display = new ReadingDisplay(this);
    protected void attachDisplay() { display.attach(); }
    protected void repairDisplay() { display.repair(); }
    protected void traceLoad(String stage) { display.trace(stage); }
    protected void requestHealthCheck() { display.requestHealthCheck(); }

    protected void destroySurface() {
        recoveryGeneration++;
        rebuilding = false;
        pauseWatchdog();
        requestedSequence.incrementAndGet();
        navigationWaiter = null;
        if (backgroundMedia != null) backgroundMedia.detach();
        surfaceGeneration++;
        for (Map.Entry<PluginCall, Runnable> entry : waiting.entrySet()) {
            handler.removeCallbacks(entry.getValue());
            entry.getKey().reject("The browser surface was closed");
        }
        waiting.clear();
        if (refreshSurface != null) {
            ViewGroup parent = (ViewGroup) refreshSurface.getParent();
            if (parent != null) parent.removeView(refreshSurface);
        }
        if (surface != null) surface.releaseSession();
        if (session != null) { extensions.forgetSession(session); if (session.isOpen()) session.close(); }
        failPendingEvaluations("The page was closed");
        bridgePort = null;
        pageRequested = false;
        initialBlank = false;
        sawRequestedPage = false;
        scrollY = 0;
        canGoBack = false;
        canGoForward = false;
        historyUrls = new java.util.ArrayList<>();
        historyIndex = -1;
        pendingHistoryIndex = -1;
        session = null;
        surface = null;
        refreshSurface = null;
        recoveryView = null;
        recoveryMessage = null;
        loadStatus = null;
        requestedUrl = "";
        hiddenState = null;
        sessionState = null;
        navigationDeadline = 0;
        awaitingRequestedStart = false;
        killedWhileHidden = false;
        recoveryFailed = false;
        recoveryAttempts = 0;
    }

    protected void applyBounds(JSObject bounds) {
        display.bounds(bounds, getBridge().getWebView(), getContext().getResources().getDisplayMetrics().density);
    }

    protected void setSurfaceVisible(boolean visible) {
        if (visible && !this.visible) displayReattached = false;
        if (visible && !this.visible && navigationDeadline != 0) navigationDeadline = SystemClock.elapsedRealtime() + NAVIGATION_TIMEOUT_MS;
        this.visible = visible;
        // An extension popup covers the page briefly and acts on it, so the page
        // stays active underneath: an inactive session drops its process into the
        // cached bucket, and the low-memory killer emptied it before popups closed.
        if (backgroundMedia != null) backgroundMedia.setActive((visible || (extensions != null && extensions.pages.hasPopup())) && resumed);
        recoverKilledPage();
        if (extensions != null && ownsForeground()) extensions.setReadingVisible(visible);
        if (refreshSurface != null) {
            refreshSurface.setVisibility(visible ? View.VISIBLE : View.INVISIBLE);
        }
        attachDisplay();
        if (session != null) session.setPriorityHint(visible && resumed ? GeckoSession.PRIORITY_HIGH : GeckoSession.PRIORITY_DEFAULT);
        if (visible && resumed) resumeWatchdog(); else pauseWatchdog();
    }

    protected void finishRefresh() {
        if (refreshSurface != null) refreshSurface.setRefreshing(false);
    }

    protected String recoveryUrl() { return requestedUrl.isEmpty() ? currentUrl : requestedUrl; }

    protected void requestNavigation(String url) {
        hiddenState = null;
        requestedUrl = url;
        pageRequested = true;
        recoveryAttempts = 0;
        if (rebuilding) return;
        if (recoveryFailed) { recoverPage("Opening the requested page", true); return; }
        awaitingRequestedStart = true;
        requestedLoadAccepted = false;
        failPendingEvaluations("A new page was requested");
        // A stream of taps must not extend the deadline of an already stuck page.
        armNavigation();
        session.stop();
        session.loadUri(url);
    }

    /** Gecko's own list, from a history or session-store snapshot; possibly seconds old. */
    protected void historyListChanged(GeckoSession.HistoryDelegate.HistoryList list) {
        if (pendingHistoryIndex >= 0 || initialBlank || awaitingRequestedStart) return;
        java.util.List<String> urls = new java.util.ArrayList<>();
        for (GeckoSession.HistoryDelegate.HistoryItem item : list) urls.add(item.getUri());
        int index = list.getCurrentIndex();
        // A snapshot taken before the latest move names another current page.
        if (index < 0 || index >= urls.size() || !urls.get(index).equals(currentUrl)) return;
        if (urls.equals(historyUrls) && index == historyIndex) return;
        historyUrls = urls;
        historyIndex = index;
        history(activeNavigation);
    }

    /** The page's location changed: a move this host asked for, or a new entry. */
    protected void locationChanged(String url) {
        if (url == null || url.isEmpty() || initialBlank) return;
        if (pendingHistoryIndex >= 0 && pendingHistoryIndex < historyUrls.size()) {
            historyIndex = pendingHistoryIndex;
            historyUrls.set(historyIndex, url);
            pendingHistoryIndex = -1;
            return;
        }
        pendingHistoryIndex = -1;
        if (historyIndex >= 0 && historyIndex < historyUrls.size() && historyUrls.get(historyIndex).equals(url)) return;
        java.util.List<String> urls = new java.util.ArrayList<>(historyUrls.subList(0, Math.max(0, Math.min(historyIndex + 1, historyUrls.size()))));
        urls.add(url);
        historyUrls = urls;
        historyIndex = urls.size() - 1;
    }

    /** A position in Gecko's history, as reported in historyChanged. */
    protected void gotoHistory(int index) {
        if (session == null || !session.isOpen() || index < 0 || index >= historyUrls.size() || index == historyIndex) return;
        pendingHistoryIndex = index;
        requestedSequence.incrementAndGet();
        awaitingRequestedStart = false;
        requestedUrl = currentUrl;
        recoveryAttempts = 0;
        armNavigation();
        session.gotoHistoryIndex(index);
    }

    protected void moveHistory(boolean forward) {
        if (session == null || !session.isOpen() || !(forward ? canGoForward : canGoBack)) return;
        int target = historyIndex + (forward ? 1 : -1);
        pendingHistoryIndex = target >= 0 && target < historyUrls.size() ? target : -1;
        requestedSequence.incrementAndGet();
        awaitingRequestedStart = false;
        requestedUrl = currentUrl;
        recoveryAttempts = 0;
        armNavigation();
        if (forward) session.goForward(); else session.goBack();
    }

    protected void armNavigation() {
        if (navigationCompleted || navigationDeadline == 0) loadStartedAt = SystemClock.elapsedRealtime();
        if (navigationDeadline == 0) navigationDeadline = SystemClock.elapsedRealtime() + NAVIGATION_TIMEOUT_MS;
        navigationCompleted = false;
        blankSince = 0;
        blankWarning = false;
        recoveryFailed = false;
        if (recoveryView != null) recoveryView.setVisibility(View.GONE);
        if (loadStatus != null) loadStatus.show("Loading page…");
        resumeWatchdog();
    }

    protected void pauseWatchdog() { display.pauseWatchdog(); }
    protected void resumeWatchdog() { display.resumeWatchdog(); }
    protected void checkHealth() { display.checkHealth(); }

    /** Detach first: late events from the discarded session cannot mutate the replacement. */
    protected void releaseReadingSession() {
        pauseWatchdog();
        GeckoSession old = session;
        session = null;
        if (surface != null) surface.releaseSession();
        if (old != null) {
            extensions.forgetSession(old);
            old.setNavigationDelegate(null);
            old.setProgressDelegate(null);
            old.setContentDelegate(null);
            if (old.isOpen()) old.close();
        }
        backgroundMedia.detach();
        forgetPageState("The page session was replaced");
        sawRequestedPage = false;
        initialBlank = false;
    }

    protected void recoverPage(String reason, boolean terminate) {
        if (destroyed || !pageRequested || rebuilding) return;
        String target = recoveryUrl();
        Log.w(TAG, reason + "; recovery=" + recoveryAttempts + "; navigation=" + activeNavigation
            + "; awaitingStart=" + awaitingRequestedStart + "; painted=" + painted
            + "; bridge=" + (bridgePort != null));
        releaseReadingSession();
        navigationDeadline = 0;
        healthSentAt = 0;
        killedWhileHidden = false;
        finishRefresh();
        boolean exhausted = recoveryAttempts++ >= 1 || !isSurfaceUrl(target);
        long requestAtRecovery = requestedSequence.get();
        rebuilding = true;
        long generation = ++recoveryGeneration;
        java.util.function.Consumer<Boolean> resume = stopped -> {
            if (generation != recoveryGeneration || destroyed) return;
            rebuilding = false;
            if ((exhausted && requestAtRecovery == requestedSequence.get()) || !stopped) {
                // Keep a closed session as the reload entry point; no retry storm.
                session = new GeckoSession();
                recoveryFailed = true;
                failed(target, -1, reason + ". Retry the page or choose another story.");
                showRecovery(reason + ". You can retry or choose another story.");
                return;
            }
            if (!visible || !resumed) { killedWhileHidden = true; return; }
            createReadingSession();
            awaitingRequestedStart = true;
            requestedLoadAccepted = false;
            armNavigation();
            session.loadUri(recoveryUrl());
            extensions.foregroundChanged();
        };
        if (terminate) engine.resetContentPool(resume);
        else handler.postDelayed(() -> resume.accept(true), 100);
    }

    protected void showRecovery(String message) {
        if (recoveryView == null) return;
        if (loadStatus != null) loadStatus.hide();
        recoveryMessage.setText(message);
        recoveryView.setVisibility(View.VISIBLE);
    }

    protected boolean isEmbeddable(String value) {
        if (value == null) return false;
        Uri uri = Uri.parse(value);
        return "http".equalsIgnoreCase(uri.getScheme()) ||
            "https".equalsIgnoreCase(uri.getScheme());
    }

    protected boolean sameAddress(String first, String second) {
        if (java.util.Objects.equals(first, second)) return true;
        if (!isEmbeddable(first) || !isEmbeddable(second)) return false;
        Uri a = Uri.parse(first), b = Uri.parse(second);
        String ap = a.getEncodedPath(), bp = b.getEncodedPath();
        if (ap == null || ap.isEmpty()) ap = "/";
        if (bp == null || bp.isEmpty()) bp = "/";
        return a.getScheme().equalsIgnoreCase(b.getScheme()) && java.util.Objects.equals(a.getHost(), b.getHost())
            && a.getPort() == b.getPort() && ap.equals(bp) && java.util.Objects.equals(a.getEncodedQuery(), b.getEncodedQuery());
    }

    /** What the surface itself may show: web pages and the extensions' own pages. */
    protected boolean isSurfaceUrl(String value) {
        if (value == null) return false;
        if (isEmbeddable(value) || "about:blank".equals(value)) return true;
        return "moz-extension".equalsIgnoreCase(Uri.parse(value).getScheme());
    }

    protected abstract GeckoSession createWindow(String url);
    protected abstract boolean ownsForeground();

    protected void showContextMenu(GeckoSession.ContentDelegate.ContextElement element) {
        LinkContextMenu.show(getActivity(), engine.runtime, LinkContextMenu.Target.of(element), (url, background) ->
            notifyListeners("openLinkRequested", new JSObject().put("url", url).put("background", background)));
    }

        protected void openExternal(String url) {
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            getActivity().startActivity(intent);
        } catch (RuntimeException ignored) {
            // The host UI remains usable when no app handles the scheme.
        }
    }

    protected void event(String name, long navigationId, String url) {
        if (!pageRequested || initialBlank) return;
        JSObject payload = new JSObject();
        payload.put("title", pageTitle);
        payload.put("navigationId", navigationId);
        payload.put("url", url == null ? "" : url);
        payload.put("sourceUrl", documentSourceUrl);
        if (documentStatus != 0) payload.put("statusCode", documentStatus);
        notifyListeners(name, payload);
    }

    protected void history(long navigationId) {
        // Gecko can report history for the session's initial blank document
        // before the requested load starts. Publishing its empty/stale URL
        // makes the shell clear the destination and close the reading surface.
        if (!pageRequested || initialBlank || !sawRequestedPage || awaitingRequestedStart) return;
        JSObject payload = new JSObject();
        payload.put("title", pageTitle);
        payload.put("navigationId", navigationId);
        payload.put("url", currentUrl);
        payload.put("canGoBack", canGoBack);
        payload.put("canGoForward", canGoForward);
        if (historyIndex >= 0) {
            payload.put("historyUrls", new com.getcapacitor.JSArray(historyUrls));
            payload.put("historyIndex", historyIndex);
        }
        notifyListeners("historyChanged", payload);
    }

    protected void failed(String url, int code, String message) {
        navigationDeadline = 0;
        finishRefresh();
        JSObject payload = new JSObject();
        payload.put("navigationId", activeNavigation);
        payload.put("url", url == null ? "" : url);
        payload.put("code", code);
        payload.put("message", message);
        notifyListeners("navigationFailed", payload);
    }

    /** Re-sends the current navigation to listeners that attached after it began. */
    protected void replayNavigation() {
        if (activeNavigation == 0) return;
        event("navigationStarted", activeNavigation, currentUrl);
        if (committedNavigation == activeNavigation) event("navigationCommitted", activeNavigation, currentUrl);
        if (navigationCompleted) event("navigationFinished", activeNavigation, currentUrl);
        history(activeNavigation);
    }

    protected void documentReady() {
        navigationDeadline = 0;
        recoveryAttempts = 0;
        blankSince = 0;
        if (blankWarning && recoveryView != null) recoveryView.setVisibility(View.GONE);
        blankWarning = false;
        finishRefresh();
        if (navigationCompleted) return;
        navigationCompleted = true;
        if (loadStatus != null) loadStatus.hide();
        traceLoad("ready");
        event("navigationFinished", activeNavigation, currentUrl);
        history(activeNavigation);
    }

    /** window.close() from the page; only a page-opened window may honour it. */
    protected void pageCloseRequested() {}

    protected void processStopped(String message) {
        forgetPageState(message);
        if (visible && resumed) {
            // Let Gecko finish closing the window before installing a replacement.
            GeckoSession lost = session;
            handler.post(() -> { if (session == lost && !destroyed) recoverPage(message, false); });
        } else killedWhileHidden = true;
    }

    protected void forgetPageState(String message) {
        if (backgroundMedia != null) backgroundMedia.reset();
        canGoForward = false;
        bridgePort = null;
        failPendingEvaluations(message);
        canGoBack = false;
        historyUrls = new java.util.ArrayList<>();
        historyIndex = -1;
        pendingHistoryIndex = -1;
        scrollY = 0;
    }

    protected abstract void attachBridge();
    protected abstract void failPendingEvaluations(String reason);

}
