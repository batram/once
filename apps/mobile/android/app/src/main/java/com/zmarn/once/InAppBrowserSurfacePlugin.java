package com.zmarn.once;

import android.app.Activity;
import android.os.Looper;
import android.os.SystemClock;
import android.content.Intent;
import android.net.Uri;
import android.util.Log;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.ActivityCallback;
import androidx.activity.result.ActivityResult;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;
import org.json.JSONObject;
import org.mozilla.geckoview.GeckoSession;
import org.mozilla.geckoview.WebExtension;

/**
 * The reading surface: a GeckoView beside the Capacitor shell. Firefox's
 * engine runs the built-in extensions (uBlock Origin, Violentmonkey) the way
 * Firefox for Android does, and a small bridge extension of Once's own
 * carries script evaluation for the source picker, which GeckoView has no
 * direct API for.
 */
@CapacitorPlugin(name = "InAppBrowserSurface")
public class InAppBrowserSurfacePlugin extends ReadingSurfaceHost {
    // Each child owns the complete recovery/media/navigation lifecycle of one page.
    // The registered plugin alone owns extension settings and the shared profile.
    private InAppBrowserSurfacePlugin owner;
    private String tabId;
    private String tabGeneration;
    private String selectedTab;
    private boolean adoptedWindow;
    private final Map<String, InAppBrowserSurfacePlugin> tabs = new HashMap<>();
    // Only identities still likely to receive late calls need remembering.
    private final java.util.Set<String> retiredTabs = new java.util.LinkedHashSet<>();
    private static final int RETIRED_TAB_LIMIT = 256;

    /** What a call for a tab that has no runtime does: only loads create one. */
    private enum Missing { CREATE, RESOLVE, REJECT }

    // Capacitor invokes plugin methods on its plugin thread, but the tab maps and
    // their sessions are UI-thread state. Returns true when the receiver should
    // run the call itself; otherwise the call was hopped, forwarded or settled.
    private boolean route(PluginCall call, Missing missing, java.util.function.Consumer<InAppBrowserSurfacePlugin> method) {
        if (owner != null) return true;
        if (Looper.myLooper() != Looper.getMainLooper()) {
            getActivity().runOnUiThread(() -> method.accept(this));
            return false;
        }
        InAppBrowserSurfacePlugin target = target(call, missing);
        if (target == this) return true;
        if (target != null) method.accept(target);
        return false;
    }

    private InAppBrowserSurfacePlugin target(PluginCall call, Missing missing) {
        if (owner != null) return this;
        String id = call.getString("tabId", selectedTab);
        if (id == null) return this;
        String generation = call.getString("generation", "");
        InAppBrowserSurfacePlugin tab = tabs.get(id);
        if (tab != null && (generation.isEmpty() || generation.equals(tab.tabGeneration))) return tab;
        if (missing == Missing.RESOLVE) { call.resolve(); return null; }
        if (retiredTabs.contains(id + ":" + generation)) {
            call.reject("The tab runtime was closed");
            return null;
        }
        if (missing == Missing.REJECT) { call.reject("No such tab"); return null; }
        if (tab != null) {
            InAppBrowserSurfacePlugin previous = tab;
            retire(id, previous.tabGeneration);
            previous.destroyed = true;
            getActivity().runOnUiThread(previous::destroySurface);
        }
        tab = new InAppBrowserSurfacePlugin();
        tab.owner = this;
        tab.tabId = id;
        tab.tabGeneration = generation;
        tab.setBridge(getBridge());
        tab.backgroundMedia = new BackgroundMedia(getContext());
        tabs.put(id, tab);
        return tab;
    }

    private void retire(String id, String generation) {
        retiredTabs.remove(id + ":" + generation);
        retiredTabs.add(id + ":" + generation);
        java.util.Iterator<String> oldest = retiredTabs.iterator();
        while (retiredTabs.size() > RETIRED_TAB_LIMIT) { oldest.next(); oldest.remove(); }
    }

    /** Every reading session, including background tabs, for per-tab extension delegates. */
    private List<GeckoSession> sessions() {
        List<GeckoSession> result = new ArrayList<>();
        if (session != null) result.add(session);
        for (InAppBrowserSurfacePlugin tab : tabs.values()) if (tab.session != null) result.add(tab.session);
        return result;
    }

    @PluginMethod
    public void selectTab(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            selectedTab = call.getString("tabId");
            for (InAppBrowserSurfacePlugin tab : tabs.values()) {
                if (!tab.tabId.equals(selectedTab)) {
                    tab.setSurfaceVisible(false);
                    if (engine != null && tab.session != null && tab.session.isOpen()) engine.runtime.getWebExtensionController().setTabActive(tab.session, false);
                }
            }
            // The root's own surface serves unscoped calls while no tab is
            // selected; a selected tab must never share the screen with it.
            if (selectedTab != null) {
                if (visible) setSurfaceVisible(false);
                if (engine != null && session != null && session.isOpen()) engine.runtime.getWebExtensionController().setTabActive(session, false);
            }
            if (extensions != null) extensions.foregroundChanged();
            call.resolve();
        });
    }

    @Override
    protected void setSurfaceVisible(boolean visible) {
        super.setSurfaceVisible(visible && ownsForeground());
    }

    @Override
    protected boolean ownsForeground() { return owner == null ? selectedTab == null : tabId.equals(owner.selectedTab); }

    @Override
    protected GeckoSession createWindow(String url) {
        if (!isEmbeddable(url)) { openExternal(url); return null; }
        InAppBrowserSurfacePlugin root = owner == null ? this : owner;
        InAppBrowserSurfacePlugin tab = new InAppBrowserSurfacePlugin();
        tab.owner = root;
        tab.tabId = java.util.UUID.randomUUID().toString();
        tab.tabGeneration = java.util.UUID.randomUUID().toString();
        tab.setBridge(getBridge());
        tab.backgroundMedia = new BackgroundMedia(getContext());
        tab.ensureEngine();
        root.tabs.put(tab.tabId, tab);
        tab.navigationReady = true;
        tab.adoptedWindow = true;
        tab.pageRequested = true;
        tab.requestedUrl = url;
        tab.currentUrl = url;
        tab.createReadingSession(false);
        // Gecko opens the returned session itself, preserving the opener.
        root.notifyListeners("newTabRequested", new JSObject().put("tabId", tab.tabId)
            .put("generation", tab.tabGeneration).put("url", url).put("navigationId", 0));
        return tab.session;
    }

    @Override
    protected void notifyListeners(String name, JSObject payload) {
        if (owner == null) { super.notifyListeners(name, payload); return; }
        if (owner.tabs.get(tabId) != this) return;
        payload.put("tabId", tabId);
        payload.put("generation", tabGeneration);
        owner.notifyListeners(name, payload);
    }

    @Override
    protected void handleOnStop() {
        super.handleOnStop();
        for (InAppBrowserSurfacePlugin tab : tabs.values()) tab.handleOnStop();
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        for (InAppBrowserSurfacePlugin tab : tabs.values()) tab.handleOnResume();
    }

    @Override
    void trimMemory(int level) {
        super.trimMemory(level);
        for (InAppBrowserSurfacePlugin tab : tabs.values()) tab.trimMemory(level);
    }

    @Override
    protected void handleOnDestroy() {
        for (InAppBrowserSurfacePlugin tab : new ArrayList<>(tabs.values())) {
            tab.destroyed = true;
            tab.destroySurface();
            tab.handler.removeCallbacksAndMessages(null);
        }
        tabs.clear();
        super.handleOnDestroy();
    }

    private final Map<Long, Runnable> evaluationTimeouts = new HashMap<>();
    private final Map<Long, PluginCall> pendingEvaluations = new HashMap<>();
    private final AtomicLong evaluationSequence = new AtomicLong();
    private JSONObject extensionSettings;
    /** Counts each settings hand-off; the bridge acknowledges the revision it applied. */
    private long settingsRevision;
    private long appliedSettingsRevision;
    private final List<SettingsWaiter> settingsWaiters = new ArrayList<>();
    private static final long SETTINGS_TIMEOUT_MS = 15000;
    private boolean navigationReady;
    private static final String BRIDGE_NATIVE_APP = "once_surface";
    /** The story list does not need a second browser engine resident in memory. */
    @Override
    public void load() {
        getActivity().runOnUiThread(() -> {
            backgroundMedia = new BackgroundMedia(getContext());
        });
    }

    private void ensureEngine() {
        if (engine != null) return;
        if (owner != null) {
            owner.ensureEngine();
            engine = owner.engine;
            extensions = owner.extensions;
            return;
        }
        engine = GeckoEngine.get(getContext());
        extensions = new GeckoExtensionManager(getActivity(), getBridge().getWebView(), engine, () -> {
            // The root's session is the reading page only while no tab is selected.
            if (selectedTab == null) return session;
            InAppBrowserSurfacePlugin tab = tabs.get(selectedTab);
            return tab == null ? null : tab.session;
        }, this::sessions,
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
        if (!route(call, Missing.CREATE, tab -> tab.open(call))) return;
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
            if (adoptedWindow) {
                // Gecko started loading the window before the shell listened to it.
                adoptedWindow = false;
                replayNavigation();
            } else requestNavigation(url);
            call.resolve();
        });
    }

    @PluginMethod
    public void navigate(PluginCall call) {
        if (!route(call, Missing.CREATE, tab -> tab.navigate(call))) return;
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
        if (!route(call, Missing.REJECT, tab -> tab.reload(call))) return;
        ready(call, () -> {
            reloadSession();
            call.resolve();
        });
    }

    @PluginMethod
    public void goBack(PluginCall call) {
        if (!route(call, Missing.REJECT, tab -> tab.goBack(call))) return;
        getActivity().runOnUiThread(() -> {
            moveHistory(false);
            call.resolve();
        });
    }

    @PluginMethod
    public void goForward(PluginCall call) {
        if (!route(call, Missing.REJECT, tab -> tab.goForward(call))) return;
        getActivity().runOnUiThread(() -> {
            moveHistory(true);
            call.resolve();
        });
    }

    @PluginMethod
    public void capturePreview(PluginCall call) {
        if (!route(call, Missing.RESOLVE, tab -> tab.capturePreview(call))) return;
        getActivity().runOnUiThread(() -> ReadingPreview.capture(this, getBridge().getWebView(), call));
    }

    @PluginMethod
    public void setBounds(PluginCall call) {
        if (!route(call, Missing.RESOLVE, tab -> tab.setBounds(call))) return;
        getActivity().runOnUiThread(() -> {
            if (surface != null) applyBounds(call.getData());
            call.resolve();
        });
    }

    /** The shell frames the visible extension page: it draws the controls and reports the rectangle. */
    @PluginMethod
    public void extensionPage(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (extensions == null) { call.reject("Extensions are not ready"); return; }
            extensions.pages.handleCommand(call);
        });
    }

    @PluginMethod
    public void setVisible(PluginCall call) {
        if (!route(call, Missing.RESOLVE, tab -> tab.setVisible(call))) return;
        getActivity().runOnUiThread(() -> {
            setSurfaceVisible(call.getBoolean("visible", false));
            call.resolve();
        });
    }

    @PluginMethod
    public void showMenu(PluginCall call) {
        if (!route(call, Missing.REJECT, tab -> tab.showMenu(call))) return;
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
        if (!route(call, Missing.REJECT, tab -> tab.evaluateJavaScript(call))) return;
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
            settingsRevision++;
            sendExtensionSettings();
            call.resolve();
        });
    }

    /**
     * One find step through Gecko's own finder: it selects and scrolls to the
     * next match, highlights the rest, and reports the count. A changed query
     * simply starts at the first match again.
     */
    @PluginMethod
    public void findInPage(PluginCall call) {
        if (!route(call, Missing.REJECT, tab -> tab.findInPage(call))) return;
        getActivity().runOnUiThread(() -> ReadingPageFinder.find(call, session));
    }

    @PluginMethod
    public void clearFind(PluginCall call) {
        if (!route(call, Missing.RESOLVE, tab -> tab.clearFind(call))) return;
        getActivity().runOnUiThread(() -> {
            if (session != null) session.getFinder().clear();
            call.resolve();
        });
    }

    /** GeckoView has no find panel of its own; the shell's bar searches. */
    @PluginMethod
    public void presentFind(PluginCall call) {
        if (!route(call, Missing.REJECT, tab -> tab.presentFind(call))) return;
        JSObject payload = new JSObject();
        payload.put("presented", false);
        call.resolve(payload);
    }

    @PluginMethod
    public void close(PluginCall call) {
        if (!route(call, Missing.RESOLVE, tab -> tab.close(call))) return;
        getActivity().runOnUiThread(() -> {
            // A closed tab never comes back: its identity is retired, so later
            // calls are rejected instead of rebuilding a session.
            if (owner != null) destroyed = true;
            destroySurface();
            if (owner != null) {
                owner.tabs.remove(tabId, this);
                owner.retire(tabId, tabGeneration);
                if (tabId.equals(owner.selectedTab)) owner.selectedTab = null;
            }
            call.resolve();
        });
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
                if (!waiting.containsKey(call)) return;
                if (destroyed || generation != surfaceGeneration) { finishWaiting(call); call.reject("The browser surface was closed"); return; }
                try {
                    extensions.adopt(installed);
                    attachBridge();
                    // Gecko starts extension background pages after the first
                    // session opens. Waiting for their settings acknowledgement
                    // before opening any session creates a 15-second timeout
                    // cycle. Bootstrap an empty session, but keep the requested
                    // URL behind the settings barrier.
                    if (session == null || !session.isOpen()) createReadingSession();
                } catch (RuntimeException error) { finishWaiting(call); call.reject("Browser operation failed", error); return; }
                // The engine starts with the first page, so the bridge receives
                // the synced filter lists and userscripts only now. That page
                // waits until they are in place: a document that starts earlier
                // neither gets its requests blocked nor its elements hidden.
                whenExtensionSettingsApplied(() -> {
                    if (!finishWaiting(call)) return;
                    if (destroyed || generation != surfaceGeneration) { call.reject("The browser surface was closed"); return; }
                    navigationReady = true;
                    try { work.run(); } catch (RuntimeException error) { call.reject("Browser operation failed", error); }
                });
            }, error -> {
                Runnable pending = waiting.remove(call);
                if (pending == null) return;
                handler.removeCallbacks(pending);
                call.reject("Browser extensions could not start: " + error.getMessage());
            });
        });
    }

    private boolean finishWaiting(PluginCall call) {
        Runnable pending = waiting.remove(call);
        if (pending == null) return false;
        handler.removeCallbacks(pending);
        return true;
    }

    private void whenExtensionSettingsApplied(Runnable work) {
        if (owner != null) { owner.whenExtensionSettingsApplied(work); return; }
        if (extensionSettings == null || appliedSettingsRevision >= settingsRevision) { work.run(); return; }
        SettingsWaiter waiter = new SettingsWaiter(work);
        settingsWaiters.add(waiter);
        handler.postDelayed(waiter, SETTINGS_TIMEOUT_MS);
    }

    /** Bounded: an unreachable filter list host must not keep every page from opening. */
    private final class SettingsWaiter implements Runnable {
        private final Runnable work;

        SettingsWaiter(Runnable work) { this.work = work; }

        @Override
        public void run() {
            if (!settingsWaiters.remove(this)) return;
            Log.w(TAG, "Extension settings were not applied in time; opening the page without them");
            work.run();
        }

        void applied() {
            if (!settingsWaiters.remove(this)) return;
            handler.removeCallbacks(this);
            work.run();
        }
    }

    /**
     * The bridge extension may still be installing when the first session
     * opens; its delegate is attached as soon as both exist.
     */
    @Override
    protected void attachBridge() {
        WebExtension bridgeExtension = extensions.bridge();
        if (bridgeExtension == null) return;
        // The session controller sees this page's content-script connections;
        // background pages arrive through the extension-wide delegate.
        WebExtension.MessageDelegate router = new PortRouter();
        if (session != null) session.getWebExtensionController().setMessageDelegate(bridgeExtension, router, BRIDGE_NATIVE_APP);
        bridgeExtension.setMessageDelegate(owner == null ? router : owner.new PortRouter(), BRIDGE_NATIVE_APP);
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
                requestHealthCheck();
            }
        }
    }

    @Override
    protected void failPendingEvaluations(String reason) {
        for (Runnable timeout : evaluationTimeouts.values()) handler.removeCallbacks(timeout);
        evaluationTimeouts.clear();
        for (PluginCall pending : pendingEvaluations.values()) pending.reject(reason);
        pendingEvaluations.clear();
    }

    private void cancelEvaluationTimeout(long id) {
        Runnable timeout = evaluationTimeouts.remove(id);
        if (timeout != null) handler.removeCallbacks(timeout);
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
                nextHealthAt = SystemClock.elapsedRealtime() + (navigationCompleted ? 5000 : 250);
                if (!awaitingRequestedStart && sameAddress(currentUrl, reply.optString("url"))) {
                    JSONObject context = reply.optJSONObject("context");
                    if (context != null) {
                        documentSourceUrl = context.optString("sourceUrl", documentSourceUrl);
                        documentStatus = context.optInt("statusCode", documentStatus);
                    }
                    String readyState = reply.optString("readyState");
                    // DOMContentLoaded plus visible paint is usable. Waiting for
                    // every image/tracker to finish needlessly kills healthy pages.
                    // BFCache restores do not always emit a new first-paint
                    // callback; keep their matching document acknowledgement.
                    if ((painted || reply.optBoolean("restored") || documentPainted && repairVerified)
                        && ("interactive".equals(readyState) || "complete".equals(readyState))) {
                        painted = true;
                        documentReady();
                    } else if ("complete".equals(readyState) && !painted) {
                        long now = SystemClock.elapsedRealtime();
                        if (blankSince == 0) blankSince = now;
                        if (!displayReattached && now - blankSince >= 750) repairDisplay();
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
            message.put("revision", settingsRevision);
            message.put("value", extensionSettings);
            settingsPort.postMessage(message);
        } catch (Exception error) {
            Log.e(TAG, "Unable to send extension settings", error);
        }
    }

    private final class SettingsPort implements WebExtension.PortDelegate {
        @Override
        public void onPortMessage(Object message, WebExtension.Port port) {
            if (!(message instanceof JSONObject)) return;
            JSONObject reply = (JSONObject) message;
            if (!"extension-settings-applied".equals(reply.optString("type"))) return;
            appliedSettingsRevision = Math.max(appliedSettingsRevision, reply.optLong("revision"));
            if (appliedSettingsRevision < settingsRevision) return;
            for (SettingsWaiter waiter : new ArrayList<>(settingsWaiters)) waiter.applied();
        }

        @Override
        public void onDisconnect(WebExtension.Port port) {
            if (settingsPort == port) settingsPort = null;
        }
    }


}
