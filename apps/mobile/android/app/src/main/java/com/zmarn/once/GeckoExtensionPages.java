package com.zmarn.once;

import android.app.Activity;
import android.app.Dialog;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.Map;
import org.mozilla.geckoview.AllowOrDeny;
import org.mozilla.geckoview.GeckoResult;
import org.mozilla.geckoview.GeckoSession;
import org.mozilla.geckoview.GeckoView;
import org.mozilla.geckoview.WebExtension;
import org.mozilla.geckoview.WebRequestError;

/** Extension tabs are real sessions. Popups keep the underlying content tab active. */
final class GeckoExtensionPages {
    private final Activity activity;
    private final GeckoEngine engine;
    private final GeckoExtensionManager manager;
    private final Map<GeckoSession, Page> pages = new LinkedHashMap<>();
    private Page visible;
    private boolean resumed = true;

    GeckoExtensionPages(Activity activity, GeckoEngine engine, GeckoExtensionManager manager) {
        this.activity = activity;
        this.engine = engine;
        this.manager = manager;
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
            visible.dialog.hide();
            visible.session.setActive(false);
            if (!visible.popup && !page.popup) engine.runtime.getWebExtensionController().setTabActive(visible.session, false);
        }
        visible = page;
        page.dialog.show();
        page.dialog.getWindow().setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
        page.session.setActive(resumed);
        manager.foregroundChanged();
    }

    boolean hasForegroundTab() { return visible != null && !visible.popup; }
    boolean hasPopup() { return visible != null && visible.popup; }
    GeckoSession foregroundTab() { return hasForegroundTab() ? visible.session : null; }
    boolean contains(GeckoSession session) { return pages.containsKey(session); }

    void close(GeckoSession session) {
        Page page = pages.remove(session);
        if (page == null) return;
        if (visible == page) visible = null;
        page.dialog.setOnDismissListener(null);
        page.dialog.dismiss();
        page.view.releaseSession();
        if (session.isOpen()) session.close();
        manager.forgetSession(session);
        if (visible == null && !pages.isEmpty()) show(new ArrayList<>(pages.keySet()).get(pages.size() - 1));
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
            page.dialog.setOnDismissListener(null);
            page.dialog.dismiss();
            page.view.releaseSession();
            if (page.session.isOpen()) page.session.close();
        }
        pages.clear();
        visible = null;
    }

    private final class Page {
        final String owner;
        final boolean popup;
        final GeckoSession session = new GeckoSession();
        final GeckoView view = new GeckoView(activity);
        final Dialog dialog = new Dialog(activity, android.R.style.Theme_Material_Light_NoActionBar);
        final TextView status = new TextView(activity);
        String url = "about:blank";

        Page(String owner, String title, boolean popup) {
            this.owner = owner;
            this.popup = popup;
            LinearLayout layout = new LinearLayout(activity);
            layout.setOrientation(LinearLayout.VERTICAL);
            LinearLayout controls = new LinearLayout(activity);
            Button close = new Button(activity);
            close.setText("Close " + title);
            close.setMaxLines(2);
            close.setEllipsize(android.text.TextUtils.TruncateAt.END);
            close.setOnClickListener(ignored -> close(session));
            Button reload = new Button(activity);
            reload.setText("Reload");
            reload.setOnClickListener(ignored -> {
                if (!session.isOpen()) session.open(engine.runtime);
                session.loadUri(url);
            });
            controls.addView(close, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
            controls.addView(reload);
            layout.addView(controls);
            layout.addView(status);
            layout.addView(view, new LinearLayout.LayoutParams(-1, 0, 1));
            dialog.setContentView(layout);
            dialog.setOnDismissListener(ignored -> close(session));
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
                    status.setText("Page could not load. Try Reload.");
                    return null;
                }
            });
            session.setProgressDelegate(new GeckoSession.ProgressDelegate() {
                @Override public void onPageStart(GeckoSession target, String value) {
                    manager.foregroundChanged();
                    url = value;
                    status.setText("Loading…");
                }
                @Override public void onPageStop(GeckoSession target, boolean success) {
                    status.setText(success ? "" : "Page could not load. Try Reload.");
                }
            });
            session.setContentDelegate(new GeckoSession.ContentDelegate() {
                @Override public void onCloseRequest(GeckoSession target) { close(target); }
                @Override public void onCrash(GeckoSession target) { status.setText("Page process crashed. Tap Reload to recover."); }
                @Override public void onKill(GeckoSession target) { status.setText("Page process stopped. Tap Reload to recover."); }
            });
        }
    }
}
