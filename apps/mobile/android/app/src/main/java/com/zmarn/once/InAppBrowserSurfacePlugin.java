package com.zmarn.once;

import android.app.AlertDialog;
import android.content.Intent;
import android.net.Uri;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.widget.EditText;
import android.widget.PopupMenu;
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import org.json.JSONObject;
import org.mozilla.geckoview.AllowOrDeny;
import org.mozilla.geckoview.GeckoResult;
import org.mozilla.geckoview.GeckoRuntime;
import org.mozilla.geckoview.GeckoRuntimeSettings;
import org.mozilla.geckoview.GeckoSession;
import org.mozilla.geckoview.GeckoView;
import org.mozilla.geckoview.WebExtension;
import org.mozilla.geckoview.WebRequestError;
import org.mozilla.geckoview.WebResponse;

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
    private static final String BRIDGE_EXTENSION_ID = "once-surface@zmarn.com";
    private static final String BRIDGE_NATIVE_APP = "once_surface";
    private static final String[][] BUILT_IN_EXTENSIONS = {
        { "resource://android/assets/once-surface/", BRIDGE_EXTENSION_ID },
        { "resource://android/assets/ublock-origin/", "uBlock0@raymondhill.net" },
        { "resource://android/assets/violentmonkey/", "{aecec67f-0d10-4fa7-b7c7-609a2db280cf}" }
    };

    /** One engine per process; sessions come and go with the surface. */
    private static GeckoRuntime runtime;
    private static WebExtension bridgeExtension;
    /** Every built-in that installed, by id; each gets tab delegates on the session. */
    private static final Map<String, WebExtension> installedExtensions = new HashMap<>();
    private static InAppBrowserSurfacePlugin activePlugin;

    private GeckoView surface;
    private GeckoSession session;
    private SwipeRefreshLayout refreshSurface;
    private final AtomicLong navigationSequence = new AtomicLong();
    private long activeNavigation;
    private String currentUrl = "";
    private boolean canGoBack;
    private int scrollY;

    /** Set once the shell asked for a page; the session's initial about:blank is not one. */
    private boolean pageRequested;
    /** True while the session's own about:blank is loading, before any requested page. */
    private boolean initialBlank;
    private boolean sawRequestedPage;

    private WebExtension.Port bridgePort;
    private final AtomicLong evaluationSequence = new AtomicLong();
    private final Map<Long, PluginCall> pendingEvaluations = new HashMap<>();

    /**
     * The engine and its built-in extensions start with the app rather than
     * with the first page, so uBlock and the bridge are in place before any
     * page loads; a content script cannot join a document that began earlier.
     */
    @Override
    public void load() {
        ensureRuntime(getContext());
    }

    @PluginMethod
    public void open(PluginCall call) {
        String url = call.getString("url");
        if (!isEmbeddable(url)) {
            call.reject("Embedded browsing only supports http and https URLs");
            return;
        }
        getActivity().runOnUiThread(() -> {
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
        getActivity().runOnUiThread(() -> {
            ensureSurface();
            pageRequested = true;
            session.loadUri(url);
            call.resolve();
        });
    }

    @PluginMethod
    public void reload(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (session != null) session.reload();
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

    @PluginMethod
    public void setVisible(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            setSurfaceVisible(call.getBoolean("visible", false));
            call.resolve();
        });
    }

    @PluginMethod
    public void showMenu(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            JSArray items = call.getArray("items");
            if (items == null) {
                call.reject("Native menu items are required");
                return;
            }
            String[] labels = new String[items.length()];
            String[] ids = new String[items.length()];
            boolean[] enabled = new boolean[items.length()];
            try {
                for (int index = 0; index < items.length(); index++) {
                    JSONObject item = items.getJSONObject(index);
                    labels[index] = item.optString("label");
                    ids[index] = item.optString("id");
                    enabled[index] = item.optBoolean("enabled", true);
                }
            } catch (Exception error) {
                call.reject("Invalid native menu items", error);
                return;
            }
            WebView shell = getBridge().getWebView();
            ViewGroup parent = (ViewGroup) shell.getParent();
            View anchor = new View(getActivity());
            JSObject bounds = call.getObject("anchor", new JSObject());
            float density = getContext().getResources().getDisplayMetrics().density;
            int width = Math.max(1, Math.round(
                (float) bounds.optDouble("width", 1) * density
            ));
            int height = Math.max(1, Math.round(
                (float) bounds.optDouble("height", 1) * density
            ));
            parent.addView(anchor, new ViewGroup.LayoutParams(width, height));
            anchor.setX(Math.round((float) bounds.optDouble("x", 0) * density));
            anchor.setY(Math.round((float) bounds.optDouble("y", 0) * density));

            PopupMenu popup = new PopupMenu(getActivity(), anchor, Gravity.END);
            for (int index = 0; index < labels.length; index++) {
                popup.getMenu()
                    .add(0, index, index, labels[index])
                    .setEnabled(enabled[index]);
            }
            AtomicBoolean resolved = new AtomicBoolean();
            popup.setOnMenuItemClickListener(item -> {
                resolved.set(true);
                JSObject result = new JSObject();
                result.put("id", ids[item.getItemId()]);
                call.resolve(result);
                return true;
            });
            popup.setOnDismissListener(ignored -> {
                parent.removeView(anchor);
                if (resolved.compareAndSet(false, true)) call.resolve();
            });
            // addView/setX/setY do not lay the synthetic anchor out
            // synchronously. Showing in the same turn makes PopupMenu observe
            // the parent's origin and clamp itself to the left edge. Posting
            // waits until the anchor has a real window position.
            anchor.post(popup::show);
        });
    }

    @PluginMethod
    public void showPrompt(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            EditText input = new EditText(getActivity());
            input.setSingleLine(true);
            input.setText(call.getString("value", ""));
            input.selectAll();
            AlertDialog dialog = new AlertDialog.Builder(getActivity())
                .setTitle(call.getString("title"))
                .setMessage(call.getString("message", ""))
                .setView(input)
                .setNegativeButton(
                    call.getString("cancelLabel", "Cancel"),
                    (ignored, index) -> call.resolve()
                )
                .setPositiveButton(
                    call.getString("confirmLabel", "OK"),
                    (ignored, index) -> {
                        JSObject result = new JSObject();
                        result.put("value", input.getText().toString());
                        call.resolve(result);
                    }
                )
                .create();
            dialog.setOnCancelListener(ignored -> call.resolve());
            dialog.setOnShowListener(ignored -> input.requestFocus());
            dialog.show();
        });
    }

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
    public void close(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            destroySurface();
            call.resolve();
        });
    }

    @Override
    protected void handleOnPause() {
        if (session != null) session.setActive(false);
    }

    @Override
    protected void handleOnResume() {
        if (session != null) session.setActive(true);
    }

    @Override
    protected void handleOnDestroy() {
        destroySurface();
    }

    private static synchronized GeckoRuntime ensureRuntime(android.content.Context context) {
        if (runtime != null) return runtime;
        boolean debuggable = (context.getApplicationInfo().flags
            & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        GeckoRuntimeSettings settings = new GeckoRuntimeSettings.Builder()
            .remoteDebuggingEnabled(debuggable)
            .build();
        runtime = GeckoRuntime.create(context.getApplicationContext(), settings);
        for (String[] extension : BUILT_IN_EXTENSIONS) {
            String uri = extension[0];
            String id = extension[1];
            runtime.getWebExtensionController().ensureBuiltIn(uri, id).accept(
                installed -> {
                    Log.i(TAG, "Extension ready: " + id);
                    installedExtensions.put(id, installed);
                    installed.setTabDelegate(NEW_TAB_TO_SURFACE);
                    if (BRIDGE_EXTENSION_ID.equals(id)) bridgeExtension = installed;
                    if (activePlugin != null) activePlugin.attachExtension(installed);
                },
                error -> Log.e(TAG, "Extension failed: " + id, error)
            );
        }
        return runtime;
    }

    /**
     * tabs.create from an extension: there is one surface, so the page loads
     * there. GeckoView wants a fresh session back, which a single surface
     * cannot give, so the extension's own call fails while the page shows.
     */
    private static final WebExtension.TabDelegate NEW_TAB_TO_SURFACE = new WebExtension.TabDelegate() {
        @Override
        public GeckoResult<GeckoSession> onNewTab(
            WebExtension source,
            WebExtension.CreateTabDetails details
        ) {
            InAppBrowserSurfacePlugin plugin = activePlugin;
            if (plugin != null && plugin.session != null && plugin.isSurfaceUrl(details.url)) {
                plugin.pageRequested = true;
                plugin.session.loadUri(details.url);
            }
            return GeckoResult.fromValue(null);
        }
    };

    /**
     * An extension that navigates "its tab" (uBlock's blocked-page, a
     * dashboard) does so through tabs.update, which GeckoView only honours
     * when the session says so.
     */
    private void attachExtension(WebExtension extension) {
        if (session == null) return;
        session.getWebExtensionController().setTabDelegate(
            extension,
            new WebExtension.SessionTabDelegate() {
                @Override
                public GeckoResult<AllowOrDeny> onUpdateTab(
                    WebExtension source,
                    GeckoSession target,
                    WebExtension.UpdateTabDetails details
                ) {
                    if (details.url != null && isSurfaceUrl(details.url)) {
                        pageRequested = true;
                        target.loadUri(details.url);
                    }
                    return GeckoResult.fromValue(AllowOrDeny.ALLOW);
                }
            }
        );
    }

    private void ensureSurface() {
        if (surface != null) return;
        GeckoRuntime engine = ensureRuntime(getContext());
        session = new GeckoSession();
        session.setNavigationDelegate(new Navigation());
        session.setProgressDelegate(new Progress());
        session.setContentDelegate(new Content());
        session.setScrollDelegate(new GeckoSession.ScrollDelegate() {
            @Override
            public void onScrollChanged(GeckoSession ignored, int x, int y) {
                scrollY = y;
            }
        });
        session.open(engine);
        activePlugin = this;
        for (WebExtension extension : installedExtensions.values()) attachExtension(extension);
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
        refreshSurface.setOnRefreshListener(() -> session.reload());

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
        if (session == null) return;
        if (bridgeExtension == null) {
            runtime.getWebExtensionController().ensureBuiltIn(
                BUILT_IN_EXTENSIONS[0][0], BRIDGE_EXTENSION_ID
            ).accept(installed -> {
                bridgeExtension = installed;
                attachBridge();
            }, error -> Log.e(TAG, "Bridge extension unavailable", error));
            return;
        }
        session.getWebExtensionController().setMessageDelegate(
            bridgeExtension,
            new WebExtension.MessageDelegate() {
                @Override
                public void onConnect(WebExtension.Port port) {
                    if (!port.sender.isTopLevel()) return;
                    bridgePort = port;
                    port.setDelegate(new BridgePort());
                }
            },
            BRIDGE_NATIVE_APP
        );
    }

    private void destroySurface() {
        if (refreshSurface != null) {
            ViewGroup parent = (ViewGroup) refreshSurface.getParent();
            if (parent != null) parent.removeView(refreshSurface);
        }
        if (surface != null) surface.releaseSession();
        if (session != null) session.close();
        failPendingEvaluations("The page was closed");
        bridgePort = null;
        pageRequested = false;
        initialBlank = false;
        sawRequestedPage = false;
        if (activePlugin == this) activePlugin = null;
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
        refreshSurface.setX(x);
        refreshSurface.setY(y);
    }

    private void setSurfaceVisible(boolean visible) {
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
            if (bridgePort == port) bridgePort = null;
            failPendingEvaluations("The page navigated away");
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

    private final class Content implements GeckoSession.ContentDelegate {
        @Override
        public void onExternalResponse(GeckoSession ignored, WebResponse response) {
            openExternal(response.uri);
        }

        @Override
        public void onCrash(GeckoSession ignored) {
            failed(currentUrl, -1, "The page's process crashed");
        }

        @Override
        public void onKill(GeckoSession ignored) {
            failed(currentUrl, -1, "The page's process was stopped");
        }
    }
}
