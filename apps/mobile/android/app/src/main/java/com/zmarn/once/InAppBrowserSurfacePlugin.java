package com.zmarn.once;

import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Message;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.DownloadListener;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.concurrent.atomic.AtomicLong;

@CapacitorPlugin(name = "InAppBrowserSurface")
public class InAppBrowserSurfacePlugin extends Plugin {
    private WebView surface;
    private SwipeRefreshLayout refreshSurface;
    private final AtomicLong navigationSequence = new AtomicLong();
    private long activeNavigation;

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
            surface.loadUrl(url);
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
            surface.loadUrl(url);
            call.resolve();
        });
    }

    @PluginMethod
    public void reload(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (surface != null) surface.reload();
            call.resolve();
        });
    }

    @PluginMethod
    public void goBack(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (surface != null && surface.canGoBack()) surface.goBack();
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
    public void close(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (surface != null) {
                ViewGroup parent = (ViewGroup) refreshSurface.getParent();
                if (parent != null) parent.removeView(refreshSurface);
                surface.stopLoading();
                surface.destroy();
                surface = null;
                refreshSurface = null;
            }
            call.resolve();
        });
    }

    @Override
    protected void handleOnPause() {
        if (surface != null) surface.onPause();
    }

    @Override
    protected void handleOnResume() {
        if (surface != null) surface.onResume();
    }

    @Override
    protected void handleOnDestroy() {
        if (surface != null) {
            surface.destroy();
            surface = null;
            refreshSurface = null;
        }
    }

    private void ensureSurface() {
        if (surface != null) return;
        surface = new WebView(getContext());
        surface.setBackgroundColor(Color.WHITE);
        surface.getSettings().setJavaScriptEnabled(true);
        surface.getSettings().setDomStorageEnabled(true);
        surface.getSettings().setSupportMultipleWindows(true);
        surface.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onCreateWindow(
                WebView view,
                boolean isDialog,
                boolean isUserGesture,
                Message resultMsg
            ) {
                WebView externalTarget = new WebView(getContext());
                externalTarget.setWebViewClient(new WebViewClient() {
                    @Override
                    public boolean shouldOverrideUrlLoading(
                        WebView ignored,
                        WebResourceRequest request
                    ) {
                        openExternal(request.getUrl().toString());
                        externalTarget.destroy();
                        return true;
                    }
                });
                WebView.WebViewTransport transport =
                    (WebView.WebViewTransport) resultMsg.obj;
                transport.setWebView(externalTarget);
                resultMsg.sendToTarget();
                return true;
            }
        });
        surface.setDownloadListener((url, userAgent, disposition, mimeType, length) ->
            openExternal(url)
        );
        surface.setWebViewClient(new SurfaceClient());

        refreshSurface = new SwipeRefreshLayout(getContext());
        refreshSurface.addView(surface, new ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        ));
        refreshSurface.setOnRefreshListener(surface::reload);

        WebView shell = getBridge().getWebView();
        ViewGroup parent = (ViewGroup) shell.getParent();
        int shellIndex = parent.indexOfChild(shell);
        parent.addView(
            refreshSurface,
            shellIndex + 1,
            new ViewGroup.LayoutParams(1, 1)
        );
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

    private void openExternal(String url) {
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            getActivity().startActivity(intent);
        } catch (RuntimeException ignored) {
            // The host UI remains usable when no app handles the scheme.
        }
    }

    private void event(String name, long navigationId, String url) {
        JSObject payload = new JSObject();
        payload.put("navigationId", navigationId);
        payload.put("url", url == null ? "" : url);
        notifyListeners(name, payload);
    }

    private void history(long navigationId, WebView view) {
        JSObject payload = new JSObject();
        payload.put("navigationId", navigationId);
        payload.put("url", view.getUrl() == null ? "" : view.getUrl());
        payload.put("canGoBack", view.canGoBack());
        notifyListeners("historyChanged", payload);
    }

    private final class SurfaceClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            String url = request.getUrl().toString();
            if (isEmbeddable(url)) return false;
            openExternal(url);
            return true;
        }

        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            activeNavigation = navigationSequence.incrementAndGet();
            event("navigationStarted", activeNavigation, url);
        }

        @Override
        public void onPageCommitVisible(WebView view, String url) {
            event("navigationCommitted", activeNavigation, url);
            history(activeNavigation, view);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            finishRefresh();
            event("navigationFinished", activeNavigation, url);
            history(activeNavigation, view);
        }

        @Override
        public void onReceivedError(
            WebView view,
            WebResourceRequest request,
            WebResourceError error
        ) {
            if (!request.isForMainFrame()) return;
            finishRefresh();
            JSObject payload = new JSObject();
            payload.put("navigationId", activeNavigation);
            payload.put("url", request.getUrl().toString());
            payload.put("code", error.getErrorCode());
            payload.put("message", String.valueOf(error.getDescription()));
            notifyListeners("navigationFailed", payload);
        }

        @Override
        public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
            handler.cancel();
            finishRefresh();
            JSObject payload = new JSObject();
            payload.put("navigationId", activeNavigation);
            payload.put("url", error.getUrl());
            payload.put("code", error.getPrimaryError());
            payload.put("message", "TLS certificate validation failed");
            notifyListeners("navigationFailed", payload);
        }
    }
}
