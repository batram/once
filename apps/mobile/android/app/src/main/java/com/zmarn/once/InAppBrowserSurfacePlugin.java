package com.zmarn.once;

import android.app.Activity;
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
import org.mozilla.geckoview.SessionFinder;
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
        String query = call.getString("query");
        if (query == null || query.isEmpty()) {
            call.reject("Search text is required");
            return;
        }
        boolean forward = call.getBoolean("forward", true);
        getActivity().runOnUiThread(() -> {
            if (session == null) {
                call.reject("There is no open page");
                return;
            }
            SessionFinder finder = session.getFinder();
            finder.setDisplayFlags(GeckoSession.FINDER_DISPLAY_HIGHLIGHT_ALL);
            int flags = forward ? 0 : GeckoSession.FINDER_FIND_BACKWARDS;
            finder.find(query, flags).accept(result -> {
                JSObject payload = new JSObject();
                payload.put("found", result != null && result.found);
                payload.put("wrapped", result != null && result.wrapped);
                payload.put("current", result == null ? 0 : result.current);
                payload.put("total", result == null ? 0 : result.total);
                call.resolve(payload);
            }, error -> call.reject("The page could not be searched: " + error));
        });
    }

    @PluginMethod
    public void clearFind(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (session != null) session.getFinder().clear();
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
