package com.zmarn.once.lite;

import android.annotation.SuppressLint;
import android.content.Context;
import android.graphics.Bitmap;
import android.net.Uri;
import android.util.Log;
import android.view.ViewGroup;
import android.webkit.ConsoleMessage;
import android.webkit.GeolocationPermissions;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import org.json.JSONObject;

/**
 * One extension page in its own WebView (`page.open`): the background page,
 * a popup, the options page or another page of the extension, at
 * `https://<host>.moz-extension.localhost/...`. The broker's page bootstrap
 * runs at document start for the extension's origin, each frame talks over
 * its own `onceLitePage` reply proxy (frame 0 is the main frame), and the
 * page wears a Firefox desktop user agent, as uBlock Origin reads it.
 */
public final class LitePage {
    static final String CHANNEL = "onceLitePage";
    public static final String PAGE_HOST_SUFFIX = ".moz-extension.localhost";
    static final String FIREFOX_UA = "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0";
    private static final String TAG = BrokerChannel.TAG;

    /** What the owner hears about the page. */
    interface Listener {
        void loaded(LitePage page, String url);
        void statusChanged(LitePage page);
        void closeRequested(LitePage page);
    }

    public final String pageId;
    public final String kind;
    public final String host;
    public final String url;
    public final String origin;
    /** The extension's display name, from the init payload the bootstrap carries. */
    public final String name;
    public final WebView view;
    final LiteTargets.Attachment attachment;
    final String marker = "once-page-" + UUID.randomUUID();
    private final BrokerChannel channel;
    private final Listener listener;
    /** The activity JS dialogs open on; the view itself has the application context. */
    private final java.util.function.Supplier<android.app.Activity> activity;
    private final Map<JavaScriptReplyProxy, Integer> frames = new LinkedHashMap<>();
    private int nextFrame = 1;
    private String status = "Loading…";
    private boolean destroyed;

    @SuppressLint("SetJavaScriptEnabled")
    LitePage(Context context, BrokerChannel channel, LiteTargets targets, JSONObject params, Listener listener,
             java.util.function.Supplier<android.app.Activity> activity) {
        this.channel = channel;
        this.listener = listener;
        this.activity = activity;
        pageId = params.optString("pageId");
        kind = params.optString("kind");
        host = params.optString("host");
        url = params.optString("url");
        origin = params.optString("origin");
        String documentStartSource = params.optString("documentStartSource");
        name = nameFrom(documentStartSource, host);
        view = new WebView(context);
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        // Extension pages fetch http lists and resources as Firefox lets them; the origin itself stays secure.
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        settings.setGeolocationEnabled(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setSupportMultipleWindows(false);
        settings.setUserAgentString(FIREFOX_UA);
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(view, "try { Object.defineProperty(window, \"__onceLiteTab\", { value: " + JSONObject.quote(marker) + ", writable: false, configurable: false }); } catch (error) {}", Collections.singleton("*"));
            WebViewCompat.addDocumentStartJavaScript(view, documentStartSource, Collections.singleton(origin));
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(view, CHANNEL, Collections.singleton(origin), (source, message, sourceOrigin, mainFrame, proxy) -> {
                if (destroyed || message.getType() != WebMessageCompat.TYPE_STRING) return;
                receive(message.getData(), sourceOrigin, mainFrame, proxy);
            });
        }
        view.setWebViewClient(new Client());
        view.setWebChromeClient(new Chrome());
        attachment = targets.register(view, marker, "page", -1, pageId, null, true);
    }

    public String status() { return status; }
    public boolean isPopup() { return "popup".equals(kind); }
    public boolean isBackground() { return "background".equals(kind); }

    /** Starts the page once its target takes requests, so the broker serves its first document. */
    void load() {
        attachment.whenReady(5000, () -> { if (!destroyed) view.loadUrl(url); });
    }

    void reload() {
        if (destroyed) return;
        setStatus("Loading…");
        view.reload();
    }

    void post(int frameId, Object message) {
        for (Map.Entry<JavaScriptReplyProxy, Integer> frame : frames.entrySet()) {
            if (frame.getValue() != frameId) continue;
            try { frame.getKey().postMessage(message.toString()); }
            catch (RuntimeException error) { Log.d(TAG, "Extension page frame went away", error); }
            return;
        }
    }

    void destroy() {
        if (destroyed) return;
        destroyed = true;
        frames.clear();
        view.setWebChromeClient(null);
        view.stopLoading();
        if (view.getParent() != null) ((ViewGroup) view.getParent()).removeView(view);
        view.destroy();
    }

    boolean isDestroyed() { return destroyed; }

    private void receive(String data, Uri sourceOrigin, boolean mainFrame, JavaScriptReplyProxy proxy) {
        Integer frameId = frames.get(proxy);
        if (frameId == null) {
            frameId = mainFrame ? 0 : nextFrame++;
            frames.put(proxy, frameId);
        }
        JSONObject message;
        try { message = new JSONObject(data); } catch (Exception error) { return; }
        try {
            String frameUrl = mainFrame && view.getUrl() != null ? view.getUrl() : sourceOrigin + "/";
            channel.event("page.message", new JSONObject().put("pageId", pageId).put("frameId", frameId)
                .put("mainFrame", mainFrame).put("url", frameUrl).put("message", message));
        } catch (Exception ignored) { /* a constant document */ }
    }

    private void setStatus(String value) {
        if (value.equals(status)) return;
        status = value;
        listener.statusChanged(this);
    }

    /** `manifest.name` (through `_locales` when it is a `__MSG_` key) from the bootstrap's init line. */
    static String nameFrom(String documentStartSource, String fallback) {
        try {
            String prefix = "window.__onceLitePageInit = ";
            int start = documentStartSource.indexOf(prefix);
            if (start < 0) return fallback;
            int end = documentStartSource.indexOf(";\n", start);
            JSONObject init = new JSONObject(documentStartSource.substring(start + prefix.length(), end < 0 ? documentStartSource.length() : end));
            String name = init.optJSONObject("manifest") == null ? "" : init.getJSONObject("manifest").optString("name", "");
            if (name.startsWith("__MSG_") && name.endsWith("__")) {
                JSONObject messages = init.optJSONObject("messages");
                JSONObject entry = messages == null ? null : messages.optJSONObject(name.substring(6, name.length() - 2));
                if (entry != null) name = entry.optString("message", name);
            }
            return name.isEmpty() ? fallback : name;
        } catch (Exception error) { return fallback; }
    }

    /**
     * The extension frames of one tab (uBlock's element picker inside a
     * page), across the WebViews the tab has had: numbered from one counter,
     * so a replaced view never reuses an id, and reachable by `page.post`
     * with `pageId: "tab:<tabId>"`.
     */
    public static final class TabFrames {
        private final Map<JavaScriptReplyProxy, Integer> frames = new LinkedHashMap<>();
        private int next = 1;

        synchronized int id(JavaScriptReplyProxy proxy) {
            Integer id = frames.get(proxy);
            if (id == null) frames.put(proxy, id = next++);
            return id;
        }

        synchronized void post(int frameId, Object message) {
            for (Map.Entry<JavaScriptReplyProxy, Integer> frame : frames.entrySet()) {
                if (frame.getValue() != frameId) continue;
                try { frame.getKey().postMessage(message.toString()); }
                catch (RuntimeException error) { Log.d(TAG, "Extension frame in a tab went away", error); }
                return;
            }
        }

        /** The tab's view went away with its frames. */
        synchronized void clear() { frames.clear(); }
    }

    /**
     * The page channel on a tab WebView, for extension frames inside pages
     * (uBlock's element picker): their messages carry `pageId: "tab:<tabId>"`.
     */
    static void listenInTab(WebView view, BrokerChannel channel, int tabId, TabFrames frames) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return;
        WebViewCompat.addWebMessageListener(view, CHANNEL, Collections.singleton("https://*" + PAGE_HOST_SUFFIX), (source, message, sourceOrigin, mainFrame, proxy) -> {
            if (message.getType() != WebMessageCompat.TYPE_STRING) return;
            int frameId = frames.id(proxy);
            try {
                channel.event("page.message", new JSONObject().put("pageId", "tab:" + tabId).put("frameId", frameId)
                    .put("mainFrame", mainFrame).put("url", mainFrame && view.getUrl() != null ? view.getUrl() : sourceOrigin + "/")
                    .put("message", new JSONObject(message.getData())));
            } catch (Exception ignored) { /* not a bootstrap message */ }
        });
    }

    public static boolean isExtensionUrl(String url) {
        if (url == null) return false;
        Uri uri = Uri.parse(url);
        if ("moz-extension".equalsIgnoreCase(uri.getScheme())) return true;
        String host = uri.getHost();
        return "https".equalsIgnoreCase(uri.getScheme()) && host != null && host.toLowerCase(java.util.Locale.ROOT).endsWith(PAGE_HOST_SUFFIX);
    }

    /** `moz-extension://<host>/p` → `https://<host>.moz-extension.localhost/p`; other URLs unchanged. */
    static String pageUrl(String url) {
        Uri uri = Uri.parse(url);
        if (!"moz-extension".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null) return url;
        return "https://" + uri.getHost() + PAGE_HOST_SUFFIX + (uri.getPath() == null ? "/" : uri.getPath())
            + (uri.getQuery() == null ? "" : "?" + uri.getQuery()) + (uri.getFragment() == null ? "" : "#" + uri.getFragment());
    }

    private final class Client extends WebViewClient {
        @Override public boolean shouldOverrideUrlLoading(WebView ignored, WebResourceRequest request) {
            String target = request.getUrl().toString();
            if ("moz-extension".equalsIgnoreCase(request.getUrl().getScheme())) {
                if (request.isForMainFrame()) view.loadUrl(pageUrl(target));
                return true;
            }
            String scheme = request.getUrl().getScheme();
            return !("https".equalsIgnoreCase(scheme) || "http".equalsIgnoreCase(scheme));
        }
        @Override public void onPageStarted(WebView ignored, String started, Bitmap favicon) {
            if (!LiteTargets.isMarkerUrl(started)) setStatus("Loading…");
        }
        @Override public void onPageFinished(WebView ignored, String finished) {
            if (destroyed || LiteTargets.isMarkerUrl(finished)) return;
            setStatus("");
            try { channel.event("page.loaded", new JSONObject().put("pageId", pageId).put("url", finished)); }
            catch (Exception ignored2) { /* a constant document */ }
            listener.loaded(LitePage.this, finished);
        }
        @Override public void onReceivedError(WebView ignored, WebResourceRequest request, WebResourceError error) {
            if (request.isForMainFrame()) setStatus("Page could not load. Try Reload.");
        }
        @Override public boolean onRenderProcessGone(WebView ignored, RenderProcessGoneDetail detail) {
            setStatus("Page process " + (detail.didCrash() ? "crashed" : "stopped") + ". Tap Reload to recover.");
            return true;
        }
    }

    private final class Chrome extends WebChromeClient {
        @Override public void onCloseWindow(WebView ignored) { listener.closeRequested(LitePage.this); }
        @Override public boolean onJsAlert(WebView ignored, String url, String message, android.webkit.JsResult result) {
            android.app.Activity owner = activity.get();
            if (owner == null || owner.isFinishing()) { result.cancel(); return true; }
            new android.app.AlertDialog.Builder(owner).setTitle(name).setMessage(message)
                .setPositiveButton(android.R.string.ok, (dialog, which) -> result.confirm()).setOnCancelListener(dialog -> result.cancel()).show();
            return true;
        }
        @Override public boolean onJsConfirm(WebView ignored, String url, String message, android.webkit.JsResult result) {
            android.app.Activity owner = activity.get();
            if (owner == null || owner.isFinishing()) { result.cancel(); return true; }
            new android.app.AlertDialog.Builder(owner).setTitle(name).setMessage(message)
                .setPositiveButton(android.R.string.ok, (dialog, which) -> result.confirm())
                .setNegativeButton(android.R.string.cancel, (dialog, which) -> result.cancel()).setOnCancelListener(dialog -> result.cancel()).show();
            return true;
        }
        @Override public boolean onJsPrompt(WebView ignored, String url, String message, String defaultValue, android.webkit.JsPromptResult result) {
            result.cancel();
            return true;
        }
        @Override public boolean onJsBeforeUnload(WebView ignored, String url, String message, android.webkit.JsResult result) { result.confirm(); return true; }
        @Override public void onPermissionRequest(PermissionRequest request) { request.deny(); }
        @Override public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) { callback.invoke(origin, false, false); }
        @Override public boolean onConsoleMessage(ConsoleMessage message) {
            String level = message.messageLevel() == ConsoleMessage.MessageLevel.ERROR ? "error"
                : message.messageLevel() == ConsoleMessage.MessageLevel.WARNING ? "warning" : "log";
            if (!"log".equals(level)) Log.println(message.messageLevel() == ConsoleMessage.MessageLevel.ERROR ? Log.ERROR : Log.WARN, "OnceLitePage",
                BrokerChannel.forLog("[" + name + "] " + message.message() + " (" + message.sourceId() + ":" + message.lineNumber() + ")"));
            try { channel.event("page.console", new JSONObject().put("pageId", pageId).put("level", level).put("message", message.message())); }
            catch (Exception ignored) { /* a constant document */ }
            return true;
        }
    }
}
