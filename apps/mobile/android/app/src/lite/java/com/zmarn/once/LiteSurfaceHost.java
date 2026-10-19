package com.zmarn.once;

import android.content.ComponentCallbacks2;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebBackForwardList;
import android.webkit.WebView;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.zmarn.once.lite.LiteBridge;
import com.zmarn.once.lite.LiteExtensionEngine;
import com.zmarn.once.lite.LiteTargets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Once Lite's reading page: one system WebView per tab beside the Capacitor
 * shell, with the view ownership, navigation bookkeeping, history list and
 * bounded recovery the GeckoView host (ReadingSurfaceHost) gives its sessions.
 * The Capacitor adapter (LiteSurfacePlugin) supplies tab routing and events.
 */
abstract class LiteSurfaceHost extends Plugin implements TabRecency.Tab {
    protected static final String TAG = "OnceLite";
    protected static final long NAVIGATION_TIMEOUT_MS = 30000;
    /** A page whose bridge stops answering health checks is restarted, as on GeckoView. */
    protected static final long RESPONSE_TIMEOUT_MS = 12000;
    /** How long a load waits for the view's DevTools target before going ahead unfiltered. */
    protected static final long TARGET_TIMEOUT_MS = 5000;
    protected final Handler handler = new Handler(Looper.getMainLooper());
    protected boolean destroyed;
    protected boolean resumed = true;
    protected boolean visible;
    protected boolean killedWhileHidden;
    protected long surfaceGeneration;
    protected final AtomicLong requestedSequence = new AtomicLong();
    protected final Map<PluginCall, Runnable> waiting = new HashMap<>();

    protected LiteWebView surface;
    /** The page view's container, where overlays over the page go (see ImageTextOverlay). */
    protected FrameLayout surfaceContent;
    protected SwipeRefreshLayout refreshSurface;
    protected LinearLayout recoveryView;
    protected TextView recoveryMessage;
    protected ReadingLoadStatus loadStatus;
    /** The saved state of a page released while hidden, restored when shown again. */
    protected Bundle hiddenState;

    protected String requestedUrl = "";
    protected String currentUrl = "";
    protected String pageTitle = "";
    protected String documentSourceUrl = "";
    protected int documentStatus;
    protected boolean pageRequested;
    protected final AtomicLong navigationSequence = new AtomicLong();
    protected long activeNavigation;
    protected long committedNavigation;
    protected boolean navigationCompleted;
    protected long navigationDeadline;
    protected long loadStartedAt;
    protected boolean recoveryFailed;
    protected int recoveryAttempts;
    protected boolean canGoBack;
    protected boolean canGoForward;
    protected List<String> historyUrls = new ArrayList<>();
    protected int historyIndex = -1;
    /** The view's own index behind each entry of historyUrls (the marker document is left out). */
    protected List<Integer> historyViewIndexes = new ArrayList<>();
    /** The app link the current page redirected to, until the next navigation. */
    protected String offeredExternalUrl;

    protected final DesktopSite desktopSite = new DesktopSite(enabled -> {
        LiteNavigation.applyDesktopSite(surface, enabled);
        notifyListeners("desktopSiteChanged", new JSObject().put("enabled", enabled));
    });
    protected final LiteDisplay display = new LiteDisplay(this);
    protected final LiteVideo video = new LiteVideo(this);
    protected LiteBackgroundMedia backgroundMedia;
    protected final LiteMediaObserver media = new LiteMediaObserver(this);
    protected final Runnable watchdog = this::checkDeadline;
    /** The tab as the extension runtime numbers it; assigned with the first view. */
    protected int liteTabId;
    protected LiteTargets.Attachment attachment;
    protected final LitePip pip = new LitePip(this);
    protected final LiteBridge bridge = new LiteBridge(handler, new BridgeEvents());
    protected long healthSentAt;
    protected long healthId;
    protected long nextHealthAt;

    protected abstract boolean ownsForeground();
    protected abstract void failPendingEvaluations(String reason);
    /** window.open from the page; the new tab's view, or null when it is not embeddable. */
    protected abstract WebView createWindow(String url);
    protected void pageCloseRequested() {}
    protected void showPageContextMenu(LinkContextMenu.Target target) {}
    /** A bridge message the host does not take (image text); true when handled. */
    protected boolean bridgeMessage(org.json.JSONObject message, Object token) { return false; }
    /** The view being created is a window Chromium opens itself (no marker load). */
    protected boolean adoptingWindow() { return false; }
    /** This tab's position among the shell's tabs, for the runtime's reports. */
    protected int tabIndex() { return 0; }

    protected LiteExtensionEngine engine() { return LiteExtensionEngine.get(getContext()); }

    @Override public boolean isLive() { return surface != null; }

    @Override
    protected void handleOnStop() {
        resumed = false;
        pauseWatchdog();
        if (backgroundMedia != null) backgroundMedia.setActive(false);
        pauseSurface();
    }

    @Override
    protected void handleOnResume() {
        resumed = true;
        if (navigationDeadline != 0) navigationDeadline = SystemClock.elapsedRealtime() + NAVIGATION_TIMEOUT_MS;
        if (backgroundMedia != null) backgroundMedia.setActive(visible);
        recoverKilledPage();
        resumeSurface();
        resumeWatchdog();
    }

    /** WebView.onPause stops the page's media too; a page playing in the background keeps running. */
    protected void pauseSurface() {
        if (surface == null || backgroundMedia != null && backgroundMedia.keepsPlaying()) return;
        surface.onPause();
    }

    protected void resumeSurface() {
        if (surface != null && visible && resumed) surface.onResume();
    }

    protected void recoverKilledPage() {
        if (!killedWhileHidden || !pageRequested || !visible || !resumed) return;
        killedWhileHidden = false;
        reloadSession();
    }

    /** Android can reclaim hidden browsing state; the RUNNING levels serve the older platforms minSdk covers. */
    @SuppressWarnings("deprecation") public void trimMemory(int level) {
        boolean pressure = level == ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW ||
            level == ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL || level >= ComponentCallbacks2.TRIM_MEMORY_BACKGROUND;
        if (!pressure) return;
        if (releaseHiddenSession()) Log.i(TAG, "Released hidden reading page under memory pressure");
    }

    /**
     * Destroys a hidden page's view, keeping its saved state to restore when it
     * is shown again. Playing media keeps its page. True when a view was released.
     */
    @Override public boolean releaseHiddenSession() {
        if (surface == null || visible && resumed || backgroundMedia != null && backgroundMedia.keepsPlaying()) return false;
        Bundle state = new Bundle();
        if (surface.saveState(state) != null) hiddenState = state;
        releaseView();
        killedWhileHidden = true;
        return true;
    }

    @Override
    protected void handleOnDestroy() {
        destroyed = true;
        destroySurface();
        handler.removeCallbacksAndMessages(null);
    }

    protected void reloadSession() {
        requestedSequence.incrementAndGet();
        recoveryAttempts = 0;
        if (surface == null) {
            if (!pageRequested || refreshSurface == null) return;
            Bundle restore = hiddenState;
            hiddenState = null;
            createView();
            armNavigation();
            String url = recoveryUrl();
            LiteWebView view = surface;
            attachment.whenReady(TARGET_TIMEOUT_MS, () -> {
                if (surface != view) return;
                if (restore == null || view.restoreState(restore) == null) view.loadUrl(url);
            });
            return;
        }
        if (recoveryFailed) { recoverPage("Restarting the page"); return; }
        armNavigation();
        surface.reload();
    }

    protected void ensureSurface() {
        if (refreshSurface != null) {
            if (surface == null) createView();
            return;
        }
        FrameLayout content = surfaceContent = new FrameLayout(getContext());
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
        // Only a drag at the top of the page pulls to refresh; the page scrolls otherwise.
        refreshSurface.setOnChildScrollUpCallback((parent, child) -> surface == null || surface.getScrollY() > 0);
        refreshSurface.setOnRefreshListener(this::reloadSession);
        WebView shell = getBridge().getWebView();
        ViewGroup parent = (ViewGroup) shell.getParent();
        int shellIndex = parent.indexOfChild(shell);
        parent.addView(refreshSurface, shellIndex + 1, new ViewGroup.LayoutParams(1, 1));
        createView();
    }

    /** A fresh WebView in the container, configured for reading; the page settings follow the tab. */
    protected void createView() {
        LiteWebView view = surface = new LiteWebView(getContext());
        LiteNavigation.configure(view, desktopSite.isEnabled());
        view.setWebViewClient(new LiteNavigation(this, view));
        view.setWebChromeClient(new LiteChrome(this, view));
        view.setDownloadListener((url, agent, disposition, mime, length) -> {
            // As Gecko's onExternalResponse: another app shows what the page cannot.
            Log.i(TAG, "download handed out: " + LogRedaction.redact(url));
            openExternal(url);
        });
        view.setOnLongClickListener(ignored -> LiteContextMenu.longPressed(this, view));
        LiteExtensionEngine engine = engine();
        if (liteTabId == 0) liteTabId = engine.nextTabId();
        // Media stays with the main-world observer: the bridge world's snapshot carries no playing state and
        // takes no play/pause yet (docs/plans/once-lite-broker-protocol.md, bridge world); PiP and scripts ride the bridge.
        media.attach(view);
        com.zmarn.once.lite.LitePage.listenInTab(view, engine.channel, liteTabId);
        attachment = engine.targets().register(view, view.marker, "tab", liteTabId, null, bridge, !adoptingWindow());
        bridge.attach(attachment);
        // Below the recovery view and the load status, which stay on top of the page.
        surfaceContent.addView(view, 0, new FrameLayout.LayoutParams(-1, -1));
        if (!visible || !resumed) view.onPause();
        reportTab();
    }

    /** Loads once the view's target takes requests, so the first document is filtered too. */
    protected void load(String url) {
        LiteWebView view = surface;
        if (view == null) return;
        attachment.whenReady(TARGET_TIMEOUT_MS, () -> { if (surface == view) view.loadUrl(url); });
    }

    /** The tab as the runtime sees it; repeated states are dropped by the engine. */
    protected void reportTab() {
        if (liteTabId == 0 || destroyed) return;
        try {
            org.json.JSONObject state = new org.json.JSONObject().put("tabId", liteTabId).put("generation", 1)
                .put("url", currentUrl.isEmpty() ? requestedUrl : currentUrl).put("title", pageTitle)
                .put("active", visible && ownsForeground()).put("index", tabIndex())
                .put("status", navigationCompleted ? "complete" : "loading")
                .put("audible", backgroundMedia != null && backgroundMedia.state.playing).put("muted", false);
            if (attachment != null && attachment.targetId() != null) state.put("targetId", attachment.targetId());
            engine().reportTab(liteTabId, state);
        } catch (org.json.JSONException ignored) { /* a constant document */ }
    }

    /** Detaches and destroys the page view; late callbacks from it are ignored by their view check. */
    protected void releaseView() {
        LiteWebView old = surface;
        surface = null;
        if (old == null) return;
        video.reset();
        pauseWatchdog();
        media.detach(old);
        if (backgroundMedia != null) backgroundMedia.detach();
        old.setWebChromeClient(null);
        old.stopLoading();
        if (attachment != null) engine().targets().unregister(attachment);
        attachment = null;
        bridge.reset();
        healthSentAt = 0;
        if (old.getParent() != null) ((ViewGroup) old.getParent()).removeView(old);
        old.destroy();
        forgetPageState("The page view was replaced");
    }

    protected void destroySurface() {
        video.reset();
        display.cancelResize();
        pauseWatchdog();
        requestedSequence.incrementAndGet();
        surfaceGeneration++;
        for (Map.Entry<PluginCall, Runnable> entry : waiting.entrySet()) {
            handler.removeCallbacks(entry.getValue());
            entry.getKey().reject("The browser surface was closed");
        }
        waiting.clear();
        releaseView();
        if (refreshSurface != null) {
            ViewGroup parent = (ViewGroup) refreshSurface.getParent();
            if (parent != null) parent.removeView(refreshSurface);
        }
        failPendingEvaluations("The page was closed");
        if (liteTabId != 0) engine().tabRemoved(liteTabId);
        pageRequested = false;
        refreshSurface = null;
        surfaceContent = null;
        recoveryView = null;
        recoveryMessage = null;
        loadStatus = null;
        requestedUrl = "";
        hiddenState = null;
        navigationDeadline = 0;
        killedWhileHidden = false;
        recoveryFailed = false;
        recoveryAttempts = 0;
    }

    protected void applyBounds(JSObject bounds) { video.bounds(bounds); }

    protected void setSurfaceVisible(boolean visible) {
        if (!visible && video.isFullscreen()) video.exit();
        if (visible && !this.visible && navigationDeadline != 0) navigationDeadline = SystemClock.elapsedRealtime() + NAVIGATION_TIMEOUT_MS;
        this.visible = visible;
        if (backgroundMedia != null) backgroundMedia.setActive(visible && resumed);
        recoverKilledPage();
        if (refreshSurface != null) refreshSurface.setVisibility(visible ? View.VISIBLE : View.INVISIBLE);
        if (visible) resumeSurface(); else pauseSurface();
        if (visible && resumed) resumeWatchdog(); else pauseWatchdog();
        reportTab();
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
        if (recoveryFailed) { recoverPage("Opening the requested page"); return; }
        failPendingEvaluations("A new page was requested");
        armNavigation();
        surface.stopLoading();
        load(url);
    }

    /** The view's own list, read after every commit: entries and the current position. */
    protected void readHistory() {
        if (surface == null) return;
        WebBackForwardList list = surface.copyBackForwardList();
        List<String> urls = new ArrayList<>();
        List<Integer> viewIndexes = new ArrayList<>();
        int current = list.getCurrentIndex();
        // The marker document the target was found by is not a page the reader visited.
        for (int index = 0; index < list.getSize(); index++) {
            String url = list.getItemAtIndex(index).getUrl();
            if (LiteTargets.isMarkerUrl(url)) { if (index < current) current--; continue; }
            urls.add(url);
            viewIndexes.add(index);
        }
        historyUrls = urls;
        historyViewIndexes = viewIndexes;
        historyIndex = Math.min(current, urls.size() - 1);
        canGoBack = historyIndex > 0;
        canGoForward = historyIndex >= 0 && historyIndex < urls.size() - 1;
    }

    protected void gotoHistory(int index) {
        if (surface == null || index < 0 || index >= historyUrls.size() || index == historyIndex || historyIndex < 0) return;
        requestedSequence.incrementAndGet();
        requestedUrl = currentUrl;
        recoveryAttempts = 0;
        armNavigation();
        surface.goBackOrForward(historyViewIndexes.get(index) - historyViewIndexes.get(historyIndex));
    }

    protected void moveHistory(boolean forward) {
        if (surface == null || !(forward ? canGoForward : canGoBack)) return;
        gotoHistory(historyIndex + (forward ? 1 : -1));
    }

    protected void armNavigation() {
        if (navigationCompleted || navigationDeadline == 0) loadStartedAt = SystemClock.elapsedRealtime();
        if (navigationDeadline == 0) navigationDeadline = SystemClock.elapsedRealtime() + NAVIGATION_TIMEOUT_MS;
        navigationCompleted = false;
        recoveryFailed = false;
        if (recoveryView != null) recoveryView.setVisibility(View.GONE);
        if (loadStatus != null) loadStatus.show("Loading page…");
        resumeWatchdog();
    }

    protected void pauseWatchdog() { handler.removeCallbacks(watchdog); healthSentAt = 0; }

    protected void resumeWatchdog() {
        handler.removeCallbacks(watchdog);
        if (!destroyed && visible && resumed && surface != null && pageRequested && !recoveryFailed)
            handler.postDelayed(watchdog, navigationCompleted ? 1000 : 250);
    }

    protected void requestHealthCheck() {
        nextHealthAt = 0;
        handler.removeCallbacks(watchdog);
        if (!destroyed && visible && resumed && surface != null && pageRequested && !recoveryFailed) handler.post(watchdog);
    }

    /**
     * A page that never finishes is restarted once, then left with Retry; a
     * bridge that stops answering health checks counts as a stopped page. The
     * health reply also drives readiness, as ReadingDisplay.checkHealth does.
     */
    protected void checkDeadline() {
        if (destroyed || !visible || !resumed || surface == null || recoveryFailed) return;
        long now = SystemClock.elapsedRealtime();
        if (healthSentAt != 0 && now - healthSentAt >= RESPONSE_TIMEOUT_MS) {
            recoverPage("The page stopped responding");
            return;
        }
        if (navigationDeadline != 0 && now >= navigationDeadline) {
            recoverPage("The page did not become ready in time");
            return;
        }
        if (bridge.isConnected() && healthSentAt == 0 && now >= nextHealthAt && ReadingAddress.embeddable(currentUrl)) {
            try {
                healthId++;
                healthSentAt = now;
                bridge.send(new org.json.JSONObject().put("type", "health").put("id", healthId));
            } catch (org.json.JSONException ignored) { healthSentAt = 0; }
        }
        resumeWatchdog();
    }

    private void healthReply(org.json.JSONObject reply) {
        if (reply.optLong("id", -1) != healthId || healthSentAt == 0) return;
        healthSentAt = 0;
        nextHealthAt = SystemClock.elapsedRealtime() + (navigationCompleted ? 5000 : 250);
        String readyState = reply.optString("readyState");
        if (!navigationCompleted && sameDocument(currentUrl, reply.optString("url"))
            && ("interactive".equals(readyState) || "complete".equals(readyState))) documentReady();
    }

    static boolean sameDocument(String left, String right) {
        if (left == null || right == null) return false;
        int hashLeft = left.indexOf('#'), hashRight = right.indexOf('#');
        return (hashLeft < 0 ? left : left.substring(0, hashLeft)).equals(hashRight < 0 ? right : right.substring(0, hashRight));
    }

    /** What the tab's bridge world says, on the main thread. */
    private final class BridgeEvents implements LiteBridge.Listener {
        @Override public void documentChanged(Object token) {
            failPendingEvaluations("The page navigated away");
            pip.connected();
            healthSentAt = 0;
            requestHealthCheck();
        }
        @Override public void documentGone(Object token) {
            pip.cancel();
            healthSentAt = 0;
            failPendingEvaluations("The page navigated away");
        }
        @Override public void message(org.json.JSONObject message, Object token) {
            String type = message.optString("type");
            if ("health".equals(type)) healthReply(message);
            else if ("media-snapshot".equals(type)) { /* the main-world observer reports media; see createView */ }
            else if ("pip-request".equals(type)) pip.receive(message);
            else bridgeMessage(message, token);
        }
    }

    /**
     * Replaces the page view and loads the page again, once; a second loss in a
     * row leaves the recovery view with Retry, as the GeckoView host does.
     */
    protected void recoverPage(String reason) {
        if (destroyed || !pageRequested) return;
        String target = recoveryUrl();
        Log.w(TAG, reason + "; recovery=" + recoveryAttempts + "; navigation=" + activeNavigation);
        releaseView();
        navigationDeadline = 0;
        killedWhileHidden = false;
        finishRefresh();
        boolean exhausted = recoveryAttempts++ >= 1 || !ReadingAddress.surface(target);
        if (exhausted) {
            recoveryFailed = true;
            failed(target, -1, reason + ". Retry the page or choose another story.");
            showRecovery(reason + ". You can retry or choose another story.");
            return;
        }
        if (!visible || !resumed) { killedWhileHidden = true; return; }
        createView();
        armNavigation();
        load(target);
    }

    protected void showRecovery(String message) {
        if (recoveryView == null) return;
        if (loadStatus != null) loadStatus.hide();
        recoveryMessage.setText(message);
        recoveryView.setVisibility(View.VISIBLE);
    }

    /**
     * The page sent the reader on to an app link (an intent:// redirect, say)
     * instead of a document, so the surface would stay blank. The shell shows
     * this as a failed page and offers to open the link in its app.
     */
    protected void offerExternal(String url) {
        Log.i(TAG, "external redirect offered: " + LogRedaction.redact(url));
        offeredExternalUrl = url;
        if (loadStatus != null) loadStatus.hide();
        failed(currentUrl, -1, ExternalLinks.describe(url), url);
    }

    protected boolean openExternal(String url) { return ExternalLinks.open(getActivity(), url); }

    protected void event(String name, long navigationId, String url) {
        if (!pageRequested) return;
        JSObject payload = new JSObject();
        payload.put("title", pageTitle);
        payload.put("navigationId", navigationId);
        payload.put("url", url == null ? "" : url);
        payload.put("sourceUrl", documentSourceUrl);
        if (documentStatus != 0) payload.put("statusCode", documentStatus);
        notifyListeners(name, payload);
    }

    protected void history(long navigationId) {
        if (!pageRequested) return;
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

    protected void failed(String url, int code, String message) { failed(url, code, message, null); }

    protected void failed(String url, int code, String message, String externalUrl) {
        navigationDeadline = 0;
        finishRefresh();
        JSObject payload = new JSObject();
        payload.put("navigationId", activeNavigation);
        payload.put("url", url == null ? "" : url);
        payload.put("code", code);
        payload.put("message", message);
        if (externalUrl != null) payload.put("externalUrl", externalUrl);
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

    /** A new document started in the view: the GeckoView host's onPageStart bookkeeping. */
    protected void pageStarted(String url) {
        offeredExternalUrl = null;
        if (backgroundMedia != null) backgroundMedia.reset();
        failPendingEvaluations("The page navigated away");
        activeNavigation = navigationSequence.incrementAndGet();
        currentUrl = url == null ? "" : url;
        pageTitle = "";
        documentSourceUrl = currentUrl;
        documentStatus = 0;
        if (ReadingAddress.surface(currentUrl)) { requestedUrl = currentUrl; armNavigation(); }
        Log.i(TAG, "load started navigation=" + activeNavigation + " visible=" + visible);
        event("navigationStarted", activeNavigation, currentUrl);
        reportTab();
    }

    protected void pageCommitted(String url) {
        currentUrl = url == null ? "" : url;
        if (ReadingAddress.surface(url)) requestedUrl = currentUrl;
        readHistory();
        committedNavigation = activeNavigation;
        event("navigationCommitted", activeNavigation, currentUrl);
        history(activeNavigation);
        reportTab();
    }

    protected void documentReady() {
        navigationDeadline = 0;
        recoveryAttempts = 0;
        finishRefresh();
        readHistory();
        if (navigationCompleted) { history(activeNavigation); return; }
        navigationCompleted = true;
        if (loadStatus != null) loadStatus.hide();
        Log.i(TAG, "load ready navigation=" + activeNavigation
            + " elapsedMs=" + (loadStartedAt == 0 ? 0 : SystemClock.elapsedRealtime() - loadStartedAt));
        event("navigationFinished", activeNavigation, currentUrl);
        history(activeNavigation);
        reportTab();
    }

    protected void forgetPageState(String message) {
        if (backgroundMedia != null) backgroundMedia.reset();
        failPendingEvaluations(message);
        canGoBack = false;
        canGoForward = false;
        historyUrls = new ArrayList<>();
        historyIndex = -1;
    }
}
