package com.zmarn.once;

import android.app.Activity;
import android.os.Handler;
import android.os.Looper;
import android.content.Intent;
import android.net.Uri;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
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
    private final Map<PluginCall, Runnable> waiting = new HashMap<>();

    private GeckoView surface;
    private GeckoSession session;
    private SwipeRefreshLayout refreshSurface;
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

    /**
     * The engine and its built-in extensions start with the app rather than
     * with the first page, so uBlock and the bridge are in place before any
     * page loads; a content script cannot join a document that began earlier.
     */
    @Override
    public void load() {
        getActivity().runOnUiThread(() -> {
            backgroundMedia = new BackgroundMedia(getContext());
            engine = GeckoEngine.get(getContext());
            extensions = new GeckoExtensionManager(getActivity(), getBridge().getWebView(), engine, () -> session,
                () -> notifyListeners("extensionsChanged", new JSObject()),
                payload -> notifyListeners("extensionPageChanged", payload));
            engine.ready().accept(installed -> {
                if (!destroyed) { extensions.adopt(installed); attachBridge(); }
            }, error -> Log.e(TAG, "Extension startup failed; next open will retry", error));
        });
    }

    @PluginMethod
    public void extensionCommand(PluginCall call) {
        getActivity().runOnUiThread(() -> {
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
        ready(call, () -> {
            ensureSurface();
            applyBounds(call.getObject("bounds", new JSObject()));
            setSurfaceVisible(call.getBoolean("visible", true));
            pageRequested = true;
            session.loadUri(url);
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
        ready(call, () -> {
            ensureSurface();
            pageRequested = true;
            session.loadUri(url);
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
            if (session != null && canGoBack) session.goBack();
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
            NativeBrowserMenu.show(getActivity(), call, session, canGoBack, canGoForward, this::reloadSession, backgroundMedia));
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
            long id = evaluationSequence.incrementAndGet();
            pendingEvaluations.put(id, call);
            handler.postDelayed(() -> {
                PluginCall pending = pendingEvaluations.remove(id);
                if (pending != null) pending.reject("The page did not answer the script request in time");
            }, 10000);
            try {
                JSONObject message = new JSONObject();
                message.put("id", id);
                message.put("code", script);
                bridgePort.postMessage(message);
            } catch (Exception error) {
                pendingEvaluations.remove(id);
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
        if (backgroundMedia != null) backgroundMedia.setActive(false);
        if (extensions != null) extensions.pages.setResumed(false);
    }

    @Override
    protected void handleOnResume() {
        resumed = true;
        if (backgroundMedia != null) backgroundMedia.setActive(visible);
        if (extensions != null) extensions.pages.setResumed(true);
        recoverKilledPage();
    }

    /**
     * A process the system reclaimed while the page was hidden comes back silently.
     * Gecko closes the session of a killed process, so the recovery reopens it
     * and loads the page again rather than reloading a session that is gone.
     */
    private void recoverKilledPage() {
        if (!killedWhileHidden || session == null || !visible || !resumed) return;
        killedWhileHidden = false;
        reloadSession();
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
    private void ready(PluginCall call, Runnable work) {
        getActivity().runOnUiThread(() -> {
            if (destroyed) { call.reject("The browser host was closed"); return; }
            long generation = surfaceGeneration;
            Runnable timeout = () -> {
                if (waiting.remove(call) != null) call.reject("Browser extensions did not become ready in time. Try again.");
            };
            waiting.put(call, timeout);
            handler.postDelayed(timeout, 30000);
            engine.ready().accept(installed -> {
                Runnable pending = waiting.remove(call);
                if (pending == null) return;
                handler.removeCallbacks(pending);
                if (destroyed || generation != surfaceGeneration) { call.reject("The browser surface was closed"); return; }
                try {
                    extensions.adopt(installed);
                    attachBridge();
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
        if (session == null) return;
        if (!session.isOpen()) {
            reopenSession();
            extensions.foregroundChanged();
            if (pageRequested && isSurfaceUrl(currentUrl)) session.loadUri(currentUrl);
        } else session.reload();
    }

    /**
     * Gecko closes a session whose process died. Reopening it makes a new window,
     * and the view only paints that window once it is attached again; without the
     * re-attach the page loads, answers scripts and stays blank on screen.
     */
    private void reopenSession() {
        if (surface != null) surface.releaseSession();
        session.open(engine.runtime);
        if (surface != null) surface.setSession(session);
        extensions.attachSession(session);
        attachBridge();
        backgroundMedia.setActive(visible && resumed);
    }

    private void ensureSurface() {
        if (surface != null) {
            if (!session.isOpen()) reopenSession();
            return;
        }
        session = new GeckoSession();
        backgroundMedia.attach(session);
        // The reading page is the selected tab: keep its process bound above the
        // cached-app bucket so the low-memory killer takes other things first.
        session.setPriorityHint(GeckoSession.PRIORITY_HIGH);
        session.setNavigationDelegate(new Navigation());
        session.setProgressDelegate(new Progress());
        session.setContentDelegate(new ReadingContentDelegate(this::openExternal, this::processStopped,
            () -> visible && resumed, () -> {
                forgetPageState("The page process was stopped while hidden");
                killedWhileHidden = true;
            }));
        session.setScrollDelegate(new GeckoSession.ScrollDelegate() {
            @Override
            public void onScrollChanged(GeckoSession ignored, int x, int y) {
                scrollY = y;
            }
        });
        session.open(engine.runtime);
        extensions.attachSession(session);
        attachBridge();

        surface = new GeckoView(getContext());
        surface.setSession(session);

        refreshSurface = new SwipeRefreshLayout(getContext());
        refreshSurface.addView(surface, new ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        ));
        // GeckoView is not a scrolling view Android knows about; the page's
        // scroll position says whether a downward drag means "refresh".
        refreshSurface.setOnChildScrollUpCallback((parent, child) -> scrollY > 0);
        refreshSurface.setOnRefreshListener(this::reloadSession);

        WebView shell = getBridge().getWebView();
        ViewGroup parent = (ViewGroup) shell.getParent();
        int shellIndex = parent.indexOfChild(shell);
        parent.addView(
            refreshSurface,
            shellIndex + 1,
            new ViewGroup.LayoutParams(1, 1)
        );
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
                port.setDelegate(new BridgePort());
            }
        }
    }

    private void destroySurface() {
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
    }

    private void failPendingEvaluations(String reason) {
        for (PluginCall pending : pendingEvaluations.values()) pending.reject(reason);
        pendingEvaluations.clear();
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
    }

    private void finishRefresh() {
        if (refreshSurface != null) refreshSurface.setRefreshing(false);
    }

    private boolean isEmbeddable(String value) {
        if (value == null) return false;
        Uri uri = Uri.parse(value);
        return "http".equalsIgnoreCase(uri.getScheme()) ||
            "https".equalsIgnoreCase(uri.getScheme());
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
        if (!pageRequested || initialBlank) return;
        JSObject payload = new JSObject();
        payload.put("navigationId", navigationId);
        payload.put("url", currentUrl);
        payload.put("canGoBack", canGoBack);
        notifyListeners("historyChanged", payload);
    }

    private void failed(String url, int code, String message) {
        finishRefresh();
        JSObject payload = new JSObject();
        payload.put("navigationId", activeNavigation);
        payload.put("url", url == null ? "" : url);
        payload.put("code", code);
        payload.put("message", message);
        notifyListeners("navigationFailed", payload);
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
            long id = reply.optLong("id", -1);
            PluginCall call = pendingEvaluations.remove(id);
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
            failPendingEvaluations("The page navigated away");
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
            currentUrl = url == null ? "" : url;
            event("navigationCommitted", activeNavigation, currentUrl);
            history(activeNavigation);
        }

        @Override
        public void onCanGoBack(GeckoSession ignored, boolean value) {
            canGoBack = value;
            history(activeNavigation);
        }

        @Override
        public void onCanGoForward(GeckoSession ignored, boolean value) {
            canGoForward = value;
        }

        @Override
        public GeckoResult<AllowOrDeny> onLoadRequest(GeckoSession ignored, LoadRequest request) {
            if (isSurfaceUrl(request.uri)) return GeckoResult.fromValue(AllowOrDeny.ALLOW);
            openExternal(request.uri);
            return GeckoResult.fromValue(AllowOrDeny.DENY);
        }

        @Override
        public GeckoResult<GeckoSession> onNewSession(GeckoSession ignored, String uri) {
            // A link that wants its own window opens in the system browser,
            // as it did with the WebView.
            openExternal(uri);
            return GeckoResult.fromValue(null);
        }

        @Override
        public GeckoResult<String> onLoadError(GeckoSession ignored, String uri, WebRequestError error) {
            failed(uri, error.code, describe(error));
            return null;
        }
    }

    private final class Progress implements GeckoSession.ProgressDelegate {
        @Override
        public void onPageStart(GeckoSession ignored, String url) {
            // A new session loads about:blank on its own before the first
            // requested page; the shell never asked for that one.
            failPendingEvaluations("The page navigated away");
            bridgePort = null;
            scrollY = 0;
            initialBlank = !sawRequestedPage && "about:blank".equals(url);
            if (!initialBlank) sawRequestedPage = true;
            activeNavigation = navigationSequence.incrementAndGet();
            currentUrl = url == null ? "" : url;
            event("navigationStarted", activeNavigation, currentUrl);
        }

        @Override
        public void onPageStop(GeckoSession ignored, boolean success) {
            finishRefresh();
            if (!success) return;
            event("navigationFinished", activeNavigation, currentUrl);
            history(activeNavigation);
        }
    }

    private void processStopped(String message) {
        forgetPageState(message);
        failed(currentUrl, -1, message);
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
