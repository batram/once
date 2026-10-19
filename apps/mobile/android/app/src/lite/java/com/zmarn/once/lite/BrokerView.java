package com.zmarn.once.lite;

import android.annotation.SuppressLint;
import android.content.Context;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.ConsoleMessage;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import java.io.ByteArrayInputStream;
import java.util.Collections;
import java.util.UUID;

/**
 * The hidden WebView the broker runs in: `https://localhost/lite-runtime.html`
 * served from the web assets, in a 1×1 container kept visible so Blink does
 * not throttle its timers. Its `onceLite` channel and `onceLiteFiles`
 * interface are installed before the page loads. A lost renderer reloads the
 * page; the broker then says hello again and Java restarts it.
 */
final class BrokerView {
    static final String RUNTIME_URL = "https://localhost/lite-runtime.html";
    static final String CHANNEL = "onceLite";
    static final String FILES = "onceLiteFiles";
    private static final String TAG = BrokerChannel.TAG;

    final WebView view;
    final String marker = "once-broker-" + UUID.randomUUID();
    private final FrameLayout container;
    private final LiteFiles files;
    private final Runnable restarted;

    @SuppressLint("SetJavaScriptEnabled")
    BrokerView(Context context, BrokerChannel channel, LiteFiles files, Runnable restarted) {
        this.files = files;
        this.restarted = restarted;
        container = new FrameLayout(context);
        view = new WebView(context);
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setGeolocationEnabled(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        view.addJavascriptInterface(files, FILES);
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(view, CHANNEL, Collections.singleton("https://localhost"), (source, message, origin, mainFrame, proxy) -> {
                if (!mainFrame || message.getType() != WebMessageCompat.TYPE_STRING) return;
                if (!channel.isConnected()) channel.connect(proxy);
                channel.receive(message.getData());
            });
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(view, "window.__onceLiteTab = " + org.json.JSONObject.quote(marker) + ";", Collections.singleton("*"));
        }
        view.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView ignored, WebResourceRequest request) {
                return serveAsset(request);
            }
            @Override public boolean shouldOverrideUrlLoading(WebView ignored, WebResourceRequest request) { return true; }
            @Override public void onPageStarted(WebView ignored, String url, android.graphics.Bitmap favicon) {
                if (url != null && url.startsWith("https://localhost/")) channel.disconnect("The broker page restarted");
            }
            @Override public boolean onRenderProcessGone(WebView ignored, RenderProcessGoneDetail detail) {
                Log.w(TAG, "Broker renderer gone (crash=" + detail.didCrash() + "); reloading the runtime");
                channel.disconnect("The broker renderer was lost");
                container.removeAllViews();
                restarted.run();
                return true;
            }
        });
        view.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onConsoleMessage(ConsoleMessage message) {
                int level = message.messageLevel() == ConsoleMessage.MessageLevel.ERROR ? Log.ERROR
                    : message.messageLevel() == ConsoleMessage.MessageLevel.WARNING ? Log.WARN : Log.DEBUG;
                Log.println(level, "OnceLiteBroker", message.message() + " (" + message.lineNumber() + ")");
                return true;
            }
        });
        container.addView(view, new FrameLayout.LayoutParams(1, 1));
        view.loadUrl("about:blank#" + marker);
    }

    void load() { view.loadUrl(RUNTIME_URL); }

    /** The container must be in a window for the page to count as visible. */
    void attachTo(ViewGroup parent) {
        ViewGroup current = (ViewGroup) container.getParent();
        if (current == parent) return;
        if (current != null) current.removeView(container);
        parent.addView(container, 0, new ViewGroup.LayoutParams(1, 1));
        container.setVisibility(View.VISIBLE);
    }

    void detach() {
        ViewGroup current = (ViewGroup) container.getParent();
        if (current != null) current.removeView(container);
    }

    void destroy() {
        detach();
        container.removeAllViews();
        view.destroy();
    }

    private WebResourceResponse serveAsset(WebResourceRequest request) {
        android.net.Uri uri = request.getUrl();
        if (!"https".equals(uri.getScheme()) || !"localhost".equals(uri.getHost())) return blocked();
        String path = uri.getPath() == null || uri.getPath().equals("/") ? "/index.html" : uri.getPath();
        byte[] bytes = files.asset("public" + path);
        if (bytes == null) {
            Log.w(TAG, "Broker asset missing: " + path);
            return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
        }
        return new WebResourceResponse(mime(path), "utf-8", 200, "OK", Collections.singletonMap("Cache-Control", "no-cache"), new ByteArrayInputStream(bytes));
    }

    private static WebResourceResponse blocked() {
        return new WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
    }

    static String mime(String path) {
        String extension = path.lastIndexOf('.') < 0 ? "" : path.substring(path.lastIndexOf('.') + 1).toLowerCase(java.util.Locale.ROOT);
        switch (extension) {
            case "html": case "htm": return "text/html";
            case "js": case "mjs": return "text/javascript";
            case "css": return "text/css";
            case "json": return "application/json";
            case "svg": return "image/svg+xml";
            case "png": return "image/png";
            case "jpg": case "jpeg": return "image/jpeg";
            case "gif": return "image/gif";
            case "webp": return "image/webp";
            case "woff": return "font/woff";
            case "woff2": return "font/woff2";
            case "ttf": return "font/ttf";
            case "wasm": return "application/wasm";
            case "xml": return "text/xml";
            case "txt": return "text/plain";
            default: return "application/octet-stream";
        }
    }
}
