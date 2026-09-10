package com.zmarn.once;

import android.app.Activity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.widget.FrameLayout;
import com.getcapacitor.JSObject;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.Consumer;
import org.mozilla.geckoview.AllowOrDeny;
import org.mozilla.geckoview.GeckoResult;
import org.mozilla.geckoview.GeckoSession;
import org.mozilla.geckoview.GeckoView;
import org.mozilla.geckoview.WebExtension;
import org.mozilla.geckoview.WebRequestError;

/**
 * Extension tabs are real sessions. Popups keep the underlying content tab active.
 * The visible page sits in a host view the shell places below its own header;
 * the shell draws the close and reload controls and reports the remaining
 * rectangle, so the app chrome stays in charge of the screen.
 */
final class GeckoExtensionPages {
    private final Activity activity;
    private final GeckoEngine engine;
    private final GeckoExtensionManager manager;
    private final Consumer<JSObject> state;
    private final WebView shell;
    private final Map<GeckoSession, Page> pages = new LinkedHashMap<>();
    private FrameLayout host;
    private Page visible;
    private boolean resumed = true;

    GeckoExtensionPages(Activity activity, WebView shell, GeckoEngine engine, GeckoExtensionManager manager, Consumer<JSObject> state) {
        this.shell = shell;
        this.activity = activity;
        this.engine = engine;
        this.manager = manager;
        this.state = state;
    }

    static boolean allowed(String url) {
        if (url == null) return true;
        return url.startsWith("https://") || url.startsWith("http://") ||
            url.startsWith("moz-extension://") || "about:blank".equals(url);
    }

    GeckoSession create(String owner, String title, boolean popup, boolean show) {
        if (pages.size() >= 12) throw new IllegalStateException("Close an extension page before opening another");
        Page page = new Page(owner, title, popup);
        pages.put(page.session, page);
        manager.attachSession(page.session);
        if (show) show(page.session);
        return page.session;
    }

    void open(WebExtension extension, String url) {
        if (!allowed(url) || url == null) throw new IllegalArgumentException("Invalid extension page URL");
        GeckoSession session = create(extension.id, extension.metaData.name, false, true);
        session.open(engine.runtime);
        session.loadUri(url);
    }

    void show(GeckoSession session) {
        Page page = pages.get(session);
        if (page == null) return;
        if (visible != null && visible != page) {
            visible.session.setActive(false);
            if (!visible.popup && !page.popup) engine.runtime.getWebExtensionController().setTabActive(visible.session, false);
        }
        visible = page;
        FrameLayout container = host();
        container.removeAllViews();
        container.addView(page.view, new FrameLayout.LayoutParams(-1, -1));
        container.setVisibility(View.VISIBLE);
        container.bringToFront();
        page.session.setActive(resumed);
        manager.foregroundChanged();
        publish();
    }

    /** Places the host where the shell laid out its frame; bounds are shell CSS pixels. */
    void setBounds(JSObject bounds) {
        float density = activity.getResources().getDisplayMetrics().density;
        FrameLayout container = host();
        ViewGroup.LayoutParams params = container.getLayoutParams();
        params.width = Math.round((float) Math.max(0, bounds.optDouble("width", 0)) * density);
        params.height = Math.round((float) Math.max(0, bounds.optDouble("height", 0)) * density);
        container.setLayoutParams(params);
        container.setX(shell.getX() + Math.round((float) Math.max(0, bounds.optDouble("x", 0)) * density));
        container.setY(shell.getY() + Math.round((float) Math.max(0, bounds.optDouble("y", 0)) * density));
    }

    void closeVisible() { if (visible != null) close(visible.session); }

    void reloadVisible() {
        if (visible == null) return;
        if (!visible.session.isOpen()) visible.session.open(engine.runtime);
        visible.session.loadUri(visible.url);
    }

    boolean hasForegroundTab() { return visible != null && !visible.popup; }
    boolean hasPopup() { return visible != null && visible.popup; }
    GeckoSession foregroundTab() { return hasForegroundTab() ? visible.session : null; }
    boolean contains(GeckoSession session) { return pages.containsKey(session); }

    void close(GeckoSession session) {
        Page page = pages.remove(session);
        if (page == null) return;
        if (visible == page) {
            visible = null;
            if (host != null) { host.removeAllViews(); host.setVisibility(View.GONE); }
        }
        page.view.releaseSession();
        if (session.isOpen()) session.close();
        manager.forgetSession(session);
        if (visible == null && !pages.isEmpty()) show(new ArrayList<>(pages.keySet()).get(pages.size() - 1));
        else publish();
        manager.foregroundChanged();
    }

    void closeOwner(String owner) {
        for (Page page : new ArrayList<>(pages.values())) if (owner.equals(page.owner)) close(page.session);
    }

    void attach(WebExtension extension) {
        for (GeckoSession session : pages.keySet()) manager.attachSessionExtension(session, extension);
    }

    void setResumed(boolean value) {
        resumed = value;
        if (visible != null) visible.session.setActive(value);
    }

    void destroy() {
        for (Page page : new ArrayList<>(pages.values())) {
            page.view.releaseSession();
            if (page.session.isOpen()) page.session.close();
        }
        pages.clear();
        visible = null;
        if (host != null && host.getParent() instanceof ViewGroup) ((ViewGroup) host.getParent()).removeView(host);
        host = null;
    }

    private FrameLayout host() {
        if (host != null) return host;
        host = new FrameLayout(activity);
        host.setVisibility(View.GONE);
        ViewGroup parent = (ViewGroup) shell.getParent();
        // Until the shell reports a frame the host stays a dot; it is still shown so a
        // page opened before the first layout is not lost, only not yet visible.
        parent.addView(host, new ViewGroup.LayoutParams(1, 1));
        return host;
    }

    private void publish() {
        JSObject payload = new JSObject();
        payload.put("open", visible != null);
        payload.put("popup", visible != null && visible.popup);
        payload.put("title", visible == null ? "" : visible.title);
        payload.put("status", visible == null ? "" : visible.status);
        payload.put("count", pages.size());
        state.accept(payload);
    }

    private final class Page {
        final String owner;
        final String title;
        final boolean popup;
        final GeckoSession session = new GeckoSession();
        final GeckoView view = new GeckoView(activity);
        String url = "about:blank";
        String status = "";

        Page(String owner, String title, boolean popup) {
            this.owner = owner;
            this.title = title;
            this.popup = popup;
            view.setSession(session);
            session.setNavigationDelegate(new GeckoSession.NavigationDelegate() {
                @Override public GeckoResult<AllowOrDeny> onLoadRequest(GeckoSession target, LoadRequest request) {
                    return GeckoResult.fromValue(allowed(request.uri) ? AllowOrDeny.ALLOW : AllowOrDeny.DENY);
                }
                @Override public GeckoResult<GeckoSession> onNewSession(GeckoSession target, String uri) {
                    if (!allowed(uri)) return GeckoResult.fromValue(null);
                    return GeckoResult.fromValue(create(owner, title, false, true));
                }
                @Override public GeckoResult<String> onLoadError(GeckoSession target, String uri, WebRequestError error) {
                    report("Page could not load. Try Reload.");
                    return null;
                }
            });
            session.setProgressDelegate(new GeckoSession.ProgressDelegate() {
                @Override public void onPageStart(GeckoSession target, String value) {
                    manager.foregroundChanged();
                    url = value;
                    report("Loading…");
                }
                @Override public void onPageStop(GeckoSession target, boolean success) {
                    report(success ? "" : "Page could not load. Try Reload.");
                }
            });
            session.setContentDelegate(new GeckoSession.ContentDelegate() {
                @Override public void onCloseRequest(GeckoSession target) { close(target); }
                @Override public void onCrash(GeckoSession target) { report("Page process crashed. Tap Reload to recover."); }
                @Override public void onKill(GeckoSession target) { report("Page process stopped. Tap Reload to recover."); }
            });
        }

        private void report(String value) {
            status = value;
            if (visible == this) publish();
        }
    }
}
