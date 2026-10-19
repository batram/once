package com.zmarn.once;

import android.app.Activity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.widget.FrameLayout;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import com.zmarn.once.lite.LiteExtensionEngine;
import com.zmarn.once.lite.LitePage;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;
import java.util.function.Supplier;

/**
 * Presents the runtime's extension pages (popups, options and other pages;
 * background pages stay hidden in the engine) in the host view the shell
 * frames below its header, exactly as GeckoExtensionPages does: the shell
 * draws the close and reload controls, reports the rectangle, and hears
 * `extensionPageChanged {open, popup, title, status, count}`.
 */
final class LiteExtensionPages implements LiteExtensionEngine.PagePresenter {
    /** Extension pages live at https://<host>.moz-extension.localhost/; the browser.* shim keeps the moz-extension form. */
    static final String PAGE_HOST_SUFFIX = LitePage.PAGE_HOST_SUFFIX;
    private final Activity activity;
    private final Supplier<WebView> shell;
    private final Supplier<LiteExtensionEngine> engine;
    private final Consumer<JSObject> state;
    private final List<LitePage> pages = new ArrayList<>();
    private FrameLayout host;
    private LitePage visible;
    private boolean resumed = true;

    LiteExtensionPages(Activity activity, Supplier<WebView> shell, Supplier<LiteExtensionEngine> engine, Consumer<JSObject> state) {
        this.activity = activity;
        this.shell = shell;
        this.engine = engine;
        this.state = state;
        publish();
    }

    static boolean isExtensionUrl(String url) { return LitePage.isExtensionUrl(url); }

    /** The shell's `extensionPage {action: close|reload|bounds}`. */
    void handleCommand(PluginCall call) {
        String action = call.getString("action", "");
        if ("close".equals(action)) closeVisible();
        else if ("reload".equals(action)) { if (visible != null) engine.get().reloadPage(visible); }
        else if ("bounds".equals(action)) setBounds(call.getObject("bounds", new JSObject()));
        else { call.reject("Unknown extension page action"); return; }
        call.resolve();
    }

    @Override public void opened(LitePage page) {
        if (pages.contains(page)) return;
        // One popup at a time, as the toolbar shows one.
        if (page.isPopup()) for (LitePage other : new ArrayList<>(pages)) if (other.isPopup()) engine.get().closePage(other);
        pages.add(page);
        show(page);
    }

    @Override public void closed(LitePage page) {
        if (!pages.remove(page)) return;
        if (visible == page) {
            visible = null;
            if (host != null) { host.removeAllViews(); host.setVisibility(View.GONE); }
        }
        if (visible == null && !pages.isEmpty()) show(pages.get(pages.size() - 1));
        else publish();
    }

    @Override public void statusChanged(LitePage page) { if (visible == page) publish(); }

    /** The shell's frame sizes the page; a popup's own size request is noted, not applied. */
    @Override public void resized(LitePage page, int width, int height) {}

    private void show(LitePage page) {
        visible = page;
        FrameLayout container = host();
        container.removeAllViews();
        if (page.view.getParent() != null) ((ViewGroup) page.view.getParent()).removeView(page.view);
        container.addView(page.view, new FrameLayout.LayoutParams(-1, -1));
        container.setVisibility(View.VISIBLE);
        container.bringToFront();
        if (resumed) page.view.onResume(); else page.view.onPause();
        publish();
    }

    /** Places the host where the shell laid out its frame; bounds are shell CSS pixels. */
    private void setBounds(JSObject bounds) {
        float density = activity.getResources().getDisplayMetrics().density;
        FrameLayout container = host();
        ViewGroup.LayoutParams params = container.getLayoutParams();
        params.width = Math.round((float) Math.max(0, bounds.optDouble("width", 0)) * density);
        params.height = Math.round((float) Math.max(0, bounds.optDouble("height", 0)) * density);
        container.setLayoutParams(params);
        container.setX(shell.get().getX() + Math.round((float) Math.max(0, bounds.optDouble("x", 0)) * density));
        container.setY(shell.get().getY() + Math.round((float) Math.max(0, bounds.optDouble("y", 0)) * density));
    }

    boolean hasPopup() { return visible != null && visible.isPopup(); }

    void closeVisible() { if (visible != null) engine.get().closePage(visible); }

    void setResumed(boolean value) {
        resumed = value;
        if (visible != null) { if (value) visible.view.onResume(); else visible.view.onPause(); }
    }

    /** Hidden pages go under memory pressure; the visible one stays. */
    void trimHidden() {
        for (LitePage page : new ArrayList<>(pages)) if (page != visible) engine.get().closePage(page);
    }

    void destroy() {
        for (LitePage page : new ArrayList<>(pages)) engine.get().closePage(page);
        pages.clear();
        visible = null;
        if (host != null && host.getParent() instanceof ViewGroup) ((ViewGroup) host.getParent()).removeView(host);
        host = null;
    }

    private FrameLayout host() {
        if (host != null) return host;
        host = new FrameLayout(activity);
        host.setVisibility(View.GONE);
        ViewGroup parent = (ViewGroup) shell.get().getParent();
        // Until the shell reports a frame the host stays a dot, so a page opened before the first layout is not lost.
        parent.addView(host, new ViewGroup.LayoutParams(1, 1));
        return host;
    }

    private void publish() {
        JSObject payload = new JSObject();
        payload.put("open", visible != null);
        payload.put("popup", visible != null && visible.isPopup());
        payload.put("title", visible == null ? "" : visible.name);
        payload.put("status", visible == null ? "" : visible.status());
        payload.put("count", pages.size());
        state.accept(payload);
    }
}
