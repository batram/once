package com.zmarn.once;

import android.app.AlertDialog;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Message;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.DownloadListener;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.PopupMenu;
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import org.json.JSONObject;

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

    @PluginMethod
    public void evaluateJavaScript(PluginCall call) {
        String script = call.getString("script");
        if (script == null || script.isEmpty()) {
            call.reject("JavaScript source is required");
            return;
        }
        getActivity().runOnUiThread(() -> {
            if (surface == null) {
                call.reject("There is no open page");
                return;
            }
            surface.evaluateJavascript(script, value -> {
                JSObject result = new JSObject();
                result.put("value", value);
                call.resolve(result);
            });
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
