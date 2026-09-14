package com.zmarn.once;

import android.app.Activity;
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
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.ActivityCallback;
import androidx.activity.result.ActivityResult;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;
import org.json.JSONObject;
import org.mozilla.geckoview.AllowOrDeny;
import org.mozilla.geckoview.GeckoResult;
import org.mozilla.geckoview.GeckoSession;
import org.mozilla.geckoview.GeckoView;
import org.mozilla.geckoview.WebExtension;
import org.mozilla.geckoview.WebRequestError;

/**
 * The reading surface: a GeckoView beside the Capacitor shell. Firefox's
 * engine runs the built-in extensions (uBlock Origin, Violentmonkey) the way
 * Firefox for Android does, and a small bridge extension of Once's own
 * carries script evaluation for the source picker, which GeckoView has no
 * direct API for.
 */
@CapacitorPlugin(name = "InAppBrowserSurface")
public class InAppBrowserSurfacePlugin extends Plugin {
    private static final String TAG = "OnceSurface";
    private static final String BRIDGE_NATIVE_APP = "once_surface";
    private GeckoEngine engine;
    private GeckoExtensionManager extensions;
    private BackgroundMedia backgroundMedia;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private boolean destroyed;
    private boolean resumed = true;
    private boolean visible;
    private boolean killedWhileHidden;
    private long surfaceGeneration;
    private final AtomicLong requestedSequence = new AtomicLong();
    private PluginCall navigationWaiter;
    private boolean navigationReady;
    private String requestedUrl = "";
    private boolean awaitingRequestedStart;
    private boolean requestedLoadAccepted;
    private long navigationDeadline;
    private long healthSentAt;
    private long healthId;
    private long nextHealthAt;
    private boolean painted;
    private boolean navigationCompleted;
    private long blankSince;
    private boolean blankWarning;
    private boolean recoveryFailed;
    private int recoveryAttempts;
    private boolean rebuilding;
    private long recoveryGeneration;
    private GeckoSession.SessionState sessionState;
    private GeckoSession.SessionState hiddenState;
    private final Runnable watchdog = this::checkHealth;
    private static final long NAVIGATION_TIMEOUT_MS = 30000;
    private static final long RESPONSE_TIMEOUT_MS = 12000;
    private final Map<PluginCall, Runnable> waiting = new HashMap<>();

    private GeckoView surface;
    private GeckoSession session;
    private SwipeRefreshLayout refreshSurface;
    private LinearLayout recoveryView;
    private TextView recoveryMessage;
    private final AtomicLong navigationSequence = new AtomicLong();
    private long activeNavigation;
    private String currentUrl = "";
    private boolean canGoBack;
    private boolean canGoForward;
    private int scrollY;

    /** Set once the shell asked for a page; the session's initial about:blank is not one. */
    private boolean pageRequested;
    /** True while the session's own about:blank is loading, before any requested page. */
    private boolean initialBlank;
    private boolean sawRequestedPage;

    private WebExtension.Port bridgePort;
    private WebExtension.Port settingsPort;
    private JSONObject extensionSettings;
    private final AtomicLong evaluationSequence = new AtomicLong();
    private final Map<Long, PluginCall> pendingEvaluations = new HashMap<>();
    private final Map<Long, Runnable> evaluationTimeouts = new HashMap<>();

    /** The story list does not need a second browser engine resident in memory. */
    @Override
    public void load() {
        getActivity().runOnUiThread(() -> {
            backgroundMedia = new BackgroundMedia(getContext());
        });
    }

    private void ensureEngine() {
        if (engine != null) return;
        engine = GeckoEngine.get(getContext());
        extensions = new GeckoExtensionManager(getActivity(), getBridge().getWebView(), engine, () -> session,
            () -> notifyListeners("extensionsChanged", new JSObject()),
            payload -> notifyListeners("extensionPageChanged", payload));
    }

    @PluginMethod
    public void extensionCommand(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            ensureEngine();
            if ("chooseFile".equals(call.getString("action"))) {
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                startActivityForResult(call, intent, "extensionFileChosen");
            } else extensions.command(call);
        });
    }

    @ActivityCallback
    private void extensionFileChosen(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            call.resolve(new JSObject().put("cancelled", true));
            return;
        }
        Uri uri = result.getData().getData();
        new Thread(() -> {
            try {
                java.io.File file = GeckoExtensionFiles.copy(getContext(), uri);
                handler.post(() -> extensions.installFile(call, file));
            } catch (Exception error) { handler.post(() -> call.reject("Could not read extension file", error)); }
        }, "once-extension-file").start();
    }

    @PluginMethod
    public void open(PluginCall call) {
        String url = call.getString("url");
        if (!isEmbeddable(url)) {
            call.reject("Embedded browsing only supports http and https URLs");
            return;
        }
        long request = requestedSequence.incrementAndGet();
        readyNavigation(call, () -> {
            if (request != requestedSequence.get()) { call.resolve(); return; }
            ensureSurface();
            applyBounds(call.getObject("bounds", new JSObject()));
            setSurfaceVisible(call.getBoolean("visible", true));
            requestNavigation(url);
            call.resolve();
        });
    }

    @PluginMethod
    public void navigate(PluginCall call) {
        String url = call.getString("url");
        if (!isEmbeddable(url)) {
            call.reject("Embedded browsing only supports http and https URLs");
            return;
        }
        long request = requestedSequence.incrementAndGet();
        readyNavigation(call, () -> {
            if (request != requestedSequence.get()) { call.resolve(); return; }
            ensureSurface();
            requestNavigation(url);
            call.resolve();
        });
    }

    @PluginMethod
    public void reload(PluginCall call) {
        ready(call, () -> {
            reloadSession();
            call.resolve();
        });
    }

    @PluginMethod
    public void goBack(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            moveHistory(false);
            call.resolve();
        });
    }

    @PluginMethod
    public void setBounds(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (surface != null) applyBounds(call.getData());
            call.resolve();
        });
    }

    /** The shell frames the visible extension page: it draws the controls and reports the rectangle. */
    @PluginMethod
    public void extensionPage(PluginCall call) {
        String action = call.getString("action", "");
        getActivity().runOnUiThread(() -> {
            if (extensions == null) { call.reject("Extensions are not ready"); return; }
            if ("close".equals(action)) extensions.pages.closeVisible();
            else if ("reload".equals(action)) extensions.pages.reloadVisible();
            else if ("bounds".equals(action)) extensions.pages.setBounds(call.getObject("bounds", new JSObject()));
            else { call.reject("Unknown extension page action"); return; }
            call.resolve();
        });
    }

    @PluginMethod
    public void setVisible(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            setSurfaceVisible(call.getBoolean("visible", false));
            call.resolve();
        });
    }

    @PluginMethod
    public void showMenu(PluginCall call) {
        if (call.getBoolean("browserControls", false)) getActivity().runOnUiThread(() ->
            NativeBrowserMenu.show(getActivity(), call, session, canGoBack, canGoForward,
                () -> moveHistory(false), () -> moveHistory(true), this::reloadSession, backgroundMedia));
        else NativeSurfaceDialogs.showMenu(getBridge(), call);
    }

    @PluginMethod
    public void showPrompt(PluginCall call) { NativeSurfaceDialogs.showPrompt(getBridge(), call); }

    /**
     * Runs the script in the page through the bridge extension's content
     * script and answers with its JSON-encoded result, as a WebView would.
     * There is no port until the page's content script has connected, which
     * happens at document start; before that there is nothing to run in.
     */
    @PluginMethod
    public void evaluateJavaScript(PluginCall call) {
        String script = call.getString("script");
        if (script == null || script.isEmpty()) {
            call.reject("JavaScript source is required");
            return;
        }
        getActivity().runOnUiThread(() -> {
            if (session == null) {
                call.reject("There is no open page");
                return;
            }
            if (bridgePort == null) {
                call.reject("The page is not ready to run scripts");
                return;
            }
            if (pendingEvaluations.size() >= 32) { call.reject("Too many pending page script requests"); return; }
            long id = evaluationSequence.incrementAndGet();
            pendingEvaluations.put(id, call);
            Runnable timeout = () -> {
                evaluationTimeouts.remove(id);
                PluginCall pending = pendingEvaluations.remove(id);
                if (pending != null) pending.reject("The page did not answer the script request in time");
            };
            evaluationTimeouts.put(id, timeout);
            handler.postDelayed(timeout, 10000);
            try {
                JSONObject message = new JSONObject();
                message.put("id", id);
                message.put("code", script);
                bridgePort.postMessage(message);
            } catch (Exception error) {
                pendingEvaluations.remove(id);
                cancelEvaluationTimeout(id);
                call.reject("The script could not be sent to the page", error);
            }
        });
    }

    @PluginMethod
    public void applyExtensionSettings(PluginCall call) {
        JSONObject data = call.getData();
        if (!data.has("filterLists") || !data.has("userscripts")) {
            call.reject("filterLists and userscripts are required");
            return;
        }
        getActivity().runOnUiThread(() -> {
            extensionSettings = data;
            sendExtensionSettings();
            call.resolve();
        });
    }

    @PluginMethod
    public void close(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            destroySurface();
            call.resolve();
        });
    }

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
        if (navigationDeadline != 0) navigationDeadline = SystemClock.elapsedRealtime() + NAVIGATION_TIMEOUT_MS;
        if (session != null) session.setPriorityHint(visible ? GeckoSession.PRIORITY_HIGH : GeckoSession.PRIORITY_DEFAULT);
        if (backgroundMedia != null) backgroundMedia.setActive(visible);
        if (extensions != null) extensions.pages.setResumed(true);
        recoverKilledPage();
        resumeWatchdog();
    }

    /**
     * A process the system reclaimed while the page was hidden comes back silently.
     * Gecko closes the session of a killed process, so the recovery reopens it
     * and loads the page again rather than reloading a session that is gone.
     */
    private void recoverKilledPage() {
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

    /** Await actual extension readiness, bounded and cancelled when the surface closes. */
    private void readyNavigation(PluginCall call, Runnable work) {
        getActivity().runOnUiThread(() -> {
            if (navigationWaiter != null) {
                Runnable previous = waiting.remove(navigationWaiter);
                if (previous != null) { handler.removeCallbacks(previous); navigationWaiter.resolve(); }
            }
            navigationWaiter = call;
            ready(call, () -> { if (navigationWaiter == call) navigationWaiter = null; work.run(); });
        });
    }

    private void ready(PluginCall call, Runnable work) {
        getActivity().runOnUiThread(() -> {
            if (destroyed) { call.reject("The browser host was closed"); return; }
            ensureEngine();
            // Once initialization is complete, navigation and Retry must not
            // wait on another round trip to the extension catalog.
            if (navigationReady) {
                try { work.run(); } catch (RuntimeException error) { call.reject("Browser operation failed", error); }
                return;
            }
            if (waiting.size() >= 16) { call.reject("Too many pending browser operations"); return; }
            long generation = surfaceGeneration;
            Runnable timeout = () -> {
                if (waiting.remove(call) != null) call.reject("Browser extensions did not become ready in time. Try again.");
            };
            waiting.put(call, timeout);
            handler.postDelayed(timeout, 30000);
            engine.ready().then(ignored -> engine.runtime.getWebExtensionController().list()).accept(installed -> {
                Runnable pending = waiting.remove(call);
                if (pending == null) return;
                handler.removeCallbacks(pending);
                if (destroyed || generation != surfaceGeneration) { call.reject("The browser surface was closed"); return; }
                try {
                    extensions.adopt(installed);
                    attachBridge();
                    navigationReady = true;
                    work.run();
                } catch (RuntimeException error) { call.reject("Browser operation failed", error); }
            }, error -> {
                Runnable pending = waiting.remove(call);
                if (pending == null) return;
                handler.removeCallbacks(pending);
                call.reject("Browser extensions could not start: " + error.getMessage());
            });
        });
    }

    private void reloadSession() {
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
    private void reopenSession() {
        releaseReadingSession();
        createReadingSession();
    }

    private void ensureSurface() {
        if (surface != null) {
            if (rebuilding) return;
            if (!recoveryFailed && (session == null || !session.isOpen())) reopenSession();
            return;
        }
        createReadingSession();

        surface = new GeckoView(getContext());
        surface.setSession(session);

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

        refreshSurface = new SwipeRefreshLayout(getContext());
        refreshSurface.addView(content, new ViewGroup.LayoutParams(-1, -1));
        refreshSurface.setOnChildScrollUpCallback((parent, child) -> scrollY > 0);
        refreshSurface.setOnRefreshListener(this::reloadSession);
        WebView shell = getBridge().getWebView();
        ViewGroup parent = (ViewGroup) shell.getParent();
        int shellIndex = parent.indexOfChild(shell);
        parent.addView(refreshSurface, shellIndex + 1, new ViewGroup.LayoutParams(1, 1));
    }

    private void createReadingSession() {
        GeckoSession created = new GeckoSession();
        session = created;
        sessionState = null;
        backgroundMedia.attach(created);
        // The reading page is the selected tab: keep its process bound above the
        // cached-app bucket so the low-memory killer takes other things first.
        session.setPriorityHint(visible && resumed ? GeckoSession.PRIORITY_HIGH : GeckoSession.PRIORITY_DEFAULT);
        session.setNavigationDelegate(new Navigation());
        session.setProgressDelegate(new Progress());
        session.setContentDelegate(new ReadingContentDelegate(url -> { if (session == created) openExternal(url); },
            message -> { if (session == created) processStopped(message); },
            () -> visible && resumed, () -> {
                if (session != created) return;
                forgetPageState("The page process was stopped while hidden");
                killedWhileHidden = true;
            }, () -> { if (session == created) painted = true; }, filename -> {
                if (session != created) return;
                Log.w(TAG, "Slow script: " + filename);
                if (navigationDeadline == 0) navigationDeadline = SystemClock.elapsedRealtime() + RESPONSE_TIMEOUT_MS;
                resumeWatchdog();
            }));
        session.setScrollDelegate(new GeckoSession.ScrollDelegate() {
            @Override
            public void onScrollChanged(GeckoSession ignored, int x, int y) {
                if (ignored != session) return;
                scrollY = y;
            }
        });
        session.open(engine.runtime);
        extensions.attachSession(session);
        attachBridge();
        if (surface != null) surface.setSession(session);
        backgroundMedia.setActive(visible && resumed);
    }

    /**
     * The bridge extension may still be installing when the first session
     * opens; its delegate is attached as soon as both exist.
     */
    private void attachBridge() {
        WebExtension bridgeExtension = extensions.bridge();
        if (bridgeExtension == null) return;
        // The session controller sees this page's content-script connections;
        // background pages arrive through the extension-wide delegate.
        WebExtension.MessageDelegate router = new PortRouter();
        if (session != null) session.getWebExtensionController().setMessageDelegate(bridgeExtension, router, BRIDGE_NATIVE_APP);
        bridgeExtension.setMessageDelegate(router, BRIDGE_NATIVE_APP);
    }

    private final class PortRouter implements WebExtension.MessageDelegate {
        @Override
        public void onConnect(WebExtension.Port port) {
            int environment = port.sender.environmentType;
            if (environment == WebExtension.MessageSender.ENV_TYPE_EXTENSION) {
                settingsPort = port;
                port.setDelegate(new SettingsPort());
                sendExtensionSettings();
            } else if (environment == WebExtension.MessageSender.ENV_TYPE_CONTENT_SCRIPT
                && port.sender.session == session
                && port.sender.isTopLevel()) {
                bridgePort = port;
                healthSentAt = 0;
                nextHealthAt = 0;
                port.setDelegate(new BridgePort());
                backgroundMedia.attachPort(port);
            }
        }
    }

    private void destroySurface() {
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
        session = null;
        surface = null;
        refreshSurface = null;
        recoveryView = null;
        recoveryMessage = null;
        requestedUrl = "";
        hiddenState = null;
        sessionState = null;
        navigationDeadline = 0;
        awaitingRequestedStart = false;
        killedWhileHidden = false;
        recoveryFailed = false;
        recoveryAttempts = 0;
    }

    private void failPendingEvaluations(String reason) {
        for (Runnable timeout : evaluationTimeouts.values()) handler.removeCallbacks(timeout);
        evaluationTimeouts.clear();
        for (PluginCall pending : pendingEvaluations.values()) pending.reject(reason);
        pendingEvaluations.clear();
    }

    private void cancelEvaluationTimeout(long id) {
        Runnable timeout = evaluationTimeouts.remove(id);
        if (timeout != null) handler.removeCallbacks(timeout);
    }

    private void applyBounds(JSObject bounds) {
        if (refreshSurface == null) return;
        float density = getContext().getResources().getDisplayMetrics().density;
        int x = Math.round((float) Math.max(0, bounds.optDouble("x", 0)) * density);
        int y = Math.round((float) Math.max(0, bounds.optDouble("y", 0)) * density);
        int width = Math.round((float) Math.max(0, bounds.optDouble("width", 0)) * density);
        int height = Math.round((float) Math.max(0, bounds.optDouble("height", 0)) * density);
        ViewGroup.LayoutParams params = refreshSurface.getLayoutParams();
        params.width = width;
        params.height = height;
        refreshSurface.setLayoutParams(params);
        // DOM bounds are relative to the shell, which can be inset by Android.
        WebView shell = getBridge().getWebView();
        refreshSurface.setX(shell.getX() + x);
        refreshSurface.setY(shell.getY() + y);
    }

    private void setSurfaceVisible(boolean visible) {
        if (visible && !this.visible && navigationDeadline != 0) navigationDeadline = SystemClock.elapsedRealtime() + NAVIGATION_TIMEOUT_MS;
        this.visible = visible;
        // An extension popup covers the page briefly and acts on it, so the page
        // stays active underneath: an inactive session drops its process into the
        // cached bucket, and the low-memory killer emptied it before popups closed.
        if (backgroundMedia != null) backgroundMedia.setActive((visible || (extensions != null && extensions.pages.hasPopup())) && resumed);
        recoverKilledPage();
        if (extensions != null) extensions.setReadingVisible(visible);
        if (refreshSurface != null) {
            refreshSurface.setVisibility(visible ? View.VISIBLE : View.INVISIBLE);
        }
        if (session != null) session.setPriorityHint(visible && resumed ? GeckoSession.PRIORITY_HIGH : GeckoSession.PRIORITY_DEFAULT);
        if (visible && resumed) resumeWatchdog(); else pauseWatchdog();
    }

    private void finishRefresh() {
        if (refreshSurface != null) refreshSurface.setRefreshing(false);
    }

    private String recoveryUrl() { return requestedUrl.isEmpty() ? currentUrl : requestedUrl; }

    private void requestNavigation(String url) {
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

    private void moveHistory(boolean forward) {
        if (session == null || !session.isOpen() || !(forward ? canGoForward : canGoBack)) return;
        requestedSequence.incrementAndGet();
        awaitingRequestedStart = false;
        requestedUrl = currentUrl;
        recoveryAttempts = 0;
        armNavigation();
        if (forward) session.goForward(); else session.goBack();
    }

    private void armNavigation() {
        if (navigationDeadline == 0) navigationDeadline = SystemClock.elapsedRealtime() + NAVIGATION_TIMEOUT_MS;
        navigationCompleted = false;
        blankSince = 0;
        blankWarning = false;
        recoveryFailed = false;
        if (recoveryView != null) recoveryView.setVisibility(View.GONE);
        resumeWatchdog();
    }

    private void pauseWatchdog() {
        handler.removeCallbacks(watchdog);
        healthSentAt = 0;
    }

    private void resumeWatchdog() {
        handler.removeCallbacks(watchdog);
        if (!destroyed && visible && resumed && session != null && pageRequested && !recoveryFailed)
            handler.postDelayed(watchdog, 1000);
    }

    private void checkHealth() {
        if (destroyed || !visible || !resumed || session == null || recoveryFailed) return;
        long now = SystemClock.elapsedRealtime();
        if (healthSentAt != 0 && now - healthSentAt >= RESPONSE_TIMEOUT_MS) {
            recoverPage("The page stopped responding", true);
            return;
        }
        if (navigationDeadline != 0 && now >= navigationDeadline) {
            recoverPage("The page did not become ready in time", true);
            return;
        }
        if (bridgePort != null && healthSentAt == 0 && now >= nextHealthAt && isEmbeddable(currentUrl)) {
            try {
                healthId++;
                healthSentAt = now;
                bridgePort.postMessage(new JSONObject().put("type", "health").put("id", healthId));
            } catch (Exception error) { healthSentAt = 0; bridgePort = null; armNavigation(); }
        }
        resumeWatchdog();
    }

    /** Detach first: late events from the discarded session cannot mutate the replacement. */
    private void releaseReadingSession() {
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

    private void recoverPage(String reason, boolean terminate) {
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

    private void showRecovery(String message) {
        if (recoveryView == null) return;
        recoveryMessage.setText(message);
        recoveryView.setVisibility(View.VISIBLE);
    }

    private boolean isEmbeddable(String value) {
        if (value == null) return false;
        Uri uri = Uri.parse(value);
        return "http".equalsIgnoreCase(uri.getScheme()) ||
            "https".equalsIgnoreCase(uri.getScheme());
    }

    private boolean sameAddress(String first, String second) {
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
    private boolean isSurfaceUrl(String value) {
        if (value == null) return false;
        if (isEmbeddable(value) || "about:blank".equals(value)) return true;
        return "moz-extension".equalsIgnoreCase(Uri.parse(value).getScheme());
    }

    private void openExternal(String url) {
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            getActivity().startActivity(intent);
        } catch (RuntimeException ignored) {
            // The host UI remains usable when no app handles the scheme.
        }
    }

    private void event(String name, long navigationId, String url) {
        if (!pageRequested || initialBlank) return;
        JSObject payload = new JSObject();
        payload.put("navigationId", navigationId);
        payload.put("url", url == null ? "" : url);
        notifyListeners(name, payload);
    }

    private void history(long navigationId) {
        // Gecko can report history for the session's initial blank document
        // before the requested load starts. Publishing its empty/stale URL
        // makes the shell clear the destination and close the reading surface.
        if (!pageRequested || initialBlank || !sawRequestedPage || awaitingRequestedStart) return;
        JSObject payload = new JSObject();
        payload.put("navigationId", navigationId);
        payload.put("url", currentUrl);
        payload.put("canGoBack", canGoBack);
        notifyListeners("historyChanged", payload);
    }

    private void failed(String url, int code, String message) {
        navigationDeadline = 0;
        finishRefresh();
        JSObject payload = new JSObject();
        payload.put("navigationId", activeNavigation);
        payload.put("url", url == null ? "" : url);
        payload.put("code", code);
        payload.put("message", message);
        notifyListeners("navigationFailed", payload);
    }

    private void documentReady() {
        navigationDeadline = 0;
        recoveryAttempts = 0;
        blankSince = 0;
        if (blankWarning && recoveryView != null) recoveryView.setVisibility(View.GONE);
        blankWarning = false;
        finishRefresh();
        if (navigationCompleted) return;
        navigationCompleted = true;
        event("navigationFinished", activeNavigation, currentUrl);
        history(activeNavigation);
    }

    private static String describe(WebRequestError error) {
        switch (error.category) {
            case WebRequestError.ERROR_CATEGORY_SECURITY:
                return "TLS certificate validation failed";
            case WebRequestError.ERROR_CATEGORY_URI:
                return "The address could not be resolved";
            case WebRequestError.ERROR_CATEGORY_NETWORK:
                return "The network request failed";
            case WebRequestError.ERROR_CATEGORY_CONTENT:
                return "The content could not be loaded";
            default:
                return "The page could not be loaded";
        }
    }

    private final class BridgePort implements WebExtension.PortDelegate {
        @Override
        public void onPortMessage(Object message, WebExtension.Port port) {
            if (!(message instanceof JSONObject)) return;
            JSONObject reply = (JSONObject) message;
            if (port != bridgePort) return;
            if ("health".equals(reply.optString("type"))) {
                if (reply.optLong("id", -1) != healthId || healthSentAt == 0) return;
                healthSentAt = 0;
                nextHealthAt = SystemClock.elapsedRealtime() + 5000;
                if (!awaitingRequestedStart && sameAddress(currentUrl, reply.optString("url"))) {
                    String readyState = reply.optString("readyState");
                    // DOMContentLoaded plus visible paint is usable. Waiting for
                    // every image/tracker to finish needlessly kills healthy pages.
                    if ((painted || reply.optBoolean("restored"))
                        && ("interactive".equals(readyState) || "complete".equals(readyState))) {
                        documentReady();
                    } else if ("complete".equals(readyState) && !painted) {
                        long now = SystemClock.elapsedRealtime();
                        if (blankSince == 0) blankSince = now;
                        if (!blankWarning && now - blankSince >= 10000) {
                            // The process answered: do not kill it or reload a
                            // broken/empty document in a loop. Keep checking for
                            // late content and offer an explicit retry meanwhile.
                            blankWarning = true;
                            failed(currentUrl, -1, "The page finished loading without visible content.");
                            showRecovery("The page finished loading without visible content. You can retry or choose another page.");
                        }
                    } else blankSince = 0;
                }
                return;
            }
            if ("media-snapshot".equals(reply.optString("type"))) { backgroundMedia.pageSnapshot(reply); return; }
            long id = reply.optLong("id", -1);
            PluginCall call = pendingEvaluations.remove(id);
            cancelEvaluationTimeout(id);
            if (call == null) return;
            String error = reply.optString("error", null);
            if (error != null && !reply.isNull("error")) {
                call.reject("The script failed: " + error);
                return;
            }
            JSObject result = new JSObject();
            result.put("value", reply.optString("value", "null"));
            call.resolve(result);
        }

        @Override
        public void onDisconnect(WebExtension.Port port) {
            if (bridgePort != port) return;
            bridgePort = null;
            healthSentAt = 0;
            backgroundMedia.attachPort(null);
            failPendingEvaluations("The page navigated away");
            if (session != null && session.isOpen() && !recoveryFailed && navigationDeadline == 0) armNavigation();
        }
    }

    private void sendExtensionSettings() {
        if (settingsPort == null || extensionSettings == null) return;
        try {
            JSONObject message = new JSONObject();
            message.put("type", "extension-settings");
            message.put("value", extensionSettings);
            settingsPort.postMessage(message);
        } catch (Exception error) {
            Log.e(TAG, "Unable to send extension settings", error);
        }
    }

    private final class SettingsPort implements WebExtension.PortDelegate {
        @Override
        public void onDisconnect(WebExtension.Port port) {
            if (settingsPort == port) settingsPort = null;
        }
    }

    private final class Navigation implements GeckoSession.NavigationDelegate {
        @Override
        public void onLocationChange(
            GeckoSession ignored,
            String url,
            java.util.List<GeckoSession.PermissionDelegate.ContentPermission> permissions,
            Boolean hasUserGesture
        ) {
            if (ignored != session || awaitingRequestedStart) return;
            currentUrl = url == null ? "" : url;
            if (isSurfaceUrl(url)) requestedUrl = currentUrl;
            event("navigationCommitted", activeNavigation, currentUrl);
            history(activeNavigation);
        }

        @Override
        public void onCanGoBack(GeckoSession ignored, boolean value) {
            if (ignored != session) return;
            canGoBack = value;
            history(activeNavigation);
        }

        @Override
        public void onCanGoForward(GeckoSession ignored, boolean value) {
            if (ignored != session) return;
            canGoForward = value;
        }

        @Override
        public GeckoResult<AllowOrDeny> onLoadRequest(GeckoSession ignored, LoadRequest request) {
            if (ignored != session) return GeckoResult.deny();
            if (awaitingRequestedStart) {
                if (sameAddress(request.uri, requestedUrl)) requestedLoadAccepted = true;
                else if (request.isRedirect && requestedLoadAccepted) requestedUrl = request.uri;
                else if (request.isDirectNavigation) return GeckoResult.deny();
            }
            if (isSurfaceUrl(request.uri)) return GeckoResult.fromValue(AllowOrDeny.ALLOW);
            openExternal(request.uri);
            return GeckoResult.fromValue(AllowOrDeny.DENY);
        }

        @Override
        public GeckoResult<GeckoSession> onNewSession(GeckoSession ignored, String uri) {
            if (ignored != session) return GeckoResult.fromValue(null);
            // A link that wants its own window opens in the system browser,
            // as it did with the WebView.
            openExternal(uri);
            return GeckoResult.fromValue(null);
        }

        @Override
        public GeckoResult<String> onLoadError(GeckoSession ignored, String uri, WebRequestError error) {
            if (ignored != session || awaitingRequestedStart && !uri.equals(requestedUrl)) return null;
            failed(uri, error.code, describe(error));
            showRecovery(describe(error) + ". Retry the page or choose another story.");
            return null;
        }
    }

    private final class Progress implements GeckoSession.ProgressDelegate {
        @Override public void onSessionStateChange(GeckoSession source, GeckoSession.SessionState state) {
            if (source == session && !awaitingRequestedStart && !initialBlank) sessionState = state;
        }
        @Override
        public void onPageStart(GeckoSession ignored, String url) {
            if (ignored != session) return;
            if (awaitingRequestedStart && !sameAddress(requestedUrl, url)) return;
            awaitingRequestedStart = false;
            painted = false;
            backgroundMedia.reset();
            backgroundMedia.attachPort(null);
            // A new session loads about:blank on its own before the first
            // requested page; the shell never asked for that one.
            failPendingEvaluations("The page navigated away");
            bridgePort = null;
            healthSentAt = 0;
            scrollY = 0;
            initialBlank = !sawRequestedPage && "about:blank".equals(url);
            if (!initialBlank) sawRequestedPage = true;
            activeNavigation = navigationSequence.incrementAndGet();
            currentUrl = url == null ? "" : url;
            if (!initialBlank && isSurfaceUrl(currentUrl)) { requestedUrl = currentUrl; armNavigation(); }
            event("navigationStarted", activeNavigation, currentUrl);
        }

        @Override
        public void onPageStop(GeckoSession ignored, boolean success) {
            if (ignored != session || awaitingRequestedStart) return;
            finishRefresh();
            // stop() also produces an unsuccessful PageStop. Do not let a
            // superseded load cover the next document with an error. Real load
            // errors arrive in onLoadError; missing completion stays bounded.
            if (!success) return;
            if (!isEmbeddable(currentUrl)) navigationDeadline = 0;
            // A successful network stop does not mean a visible, responsive
            // document. The matching content-port health reply completes web
            // navigation, including BFCache restores and stalled subresources.
            if (!isEmbeddable(currentUrl)) documentReady();
            nextHealthAt = 0;
        }
    }

    private void processStopped(String message) {
        forgetPageState(message);
        if (visible && resumed) {
            // Let Gecko finish closing the window before installing a replacement.
            GeckoSession lost = session;
            handler.post(() -> { if (session == lost && !destroyed) recoverPage(message, false); });
        } else killedWhileHidden = true;
    }

    private void forgetPageState(String message) {
        if (backgroundMedia != null) backgroundMedia.reset();
        canGoForward = false;
        bridgePort = null;
        failPendingEvaluations(message);
        canGoBack = false;
        scrollY = 0;
    }

}
