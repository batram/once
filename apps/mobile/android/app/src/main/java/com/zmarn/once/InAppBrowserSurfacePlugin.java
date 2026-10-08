package com.zmarn.once;

import android.app.Activity;
import android.os.Looper;
import android.os.SystemClock;
import android.content.Intent;
import android.net.Uri;
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
import org.json.JSONObject;
import org.mozilla.geckoview.GeckoSession;
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
    // Each child owns the complete recovery/media/navigation lifecycle of one page.
    // The registered plugin alone owns extension settings and the shared profile.
    private InAppBrowserSurfacePlugin owner;
    private String tabId;
    private String tabGeneration;
    private String selectedTab;
    private boolean adoptedWindow;
    // Opened by a page's window.open, so that page's script may close it again.
    private boolean openedByPage;
    private final Map<String, InAppBrowserSurfacePlugin> tabs = new HashMap<>();
    // Only identities still likely to receive late calls need remembering.
    private final java.util.Set<String> retiredTabs = new java.util.LinkedHashSet<>();
    private static final int RETIRED_TAB_LIMIT = 256;

    /** What a call for a tab that has no runtime does: loads and menus create one. */
    private enum Missing { CREATE, RESOLVE, REJECT }
    /** Long-press menus waiting for the shell's items, by request; held by the root plugin. */
    private final Map<String, java.util.function.Consumer<List<LinkContextMenu.Item>>> pendingMenus = new HashMap<>();
    private static final long MENU_ITEMS_TIMEOUT_MS = 400;

    // Capacitor invokes plugin methods on its plugin thread, but the tab maps and
    // their sessions are UI-thread state. Returns true when the receiver should
    // run the call itself; otherwise the call was hopped, forwarded or settled.
    private boolean route(PluginCall call, Missing missing, java.util.function.Consumer<InAppBrowserSurfacePlugin> method) {
        if (owner != null) return true;
        if (Looper.myLooper() != Looper.getMainLooper()) {
            getActivity().runOnUiThread(() -> method.accept(this));
            return false;
        }
        InAppBrowserSurfacePlugin target = target(call, missing);
        if (target == this) return true;
        if (target != null) method.accept(target);
        return false;
    }

    private InAppBrowserSurfacePlugin target(PluginCall call, Missing missing) {
        if (owner != null) return this;
        String id = call.getString("tabId", selectedTab);
        if (id == null) return this;
        String generation = call.getString("generation", "");
        InAppBrowserSurfacePlugin tab = tabs.get(id);
        if (tab != null && (generation.isEmpty() || generation.equals(tab.tabGeneration))) return tab;
        if (missing == Missing.RESOLVE) { call.resolve(); return null; }
        if (retiredTabs.contains(id + ":" + generation)) {
            call.reject("The tab runtime was closed");
            return null;
        }
        if (missing == Missing.REJECT) { call.reject("No such tab"); return null; }
        if (tab != null) {
            InAppBrowserSurfacePlugin previous = tab;
            retire(id, previous.tabGeneration);
            previous.destroyed = true;
            getActivity().runOnUiThread(previous::destroySurface);
        }
        tab = new InAppBrowserSurfacePlugin();
        tab.owner = this;
        tab.tabId = id;
        tab.tabGeneration = generation;
        tab.setBridge(getBridge());
        tab.backgroundMedia = new BackgroundMedia(getContext());
        tabs.put(id, tab);
        return tab;
    }

    private void retire(String id, String generation) {
        retiredTabs.remove(id + ":" + generation);
        retiredTabs.add(id + ":" + generation);
        java.util.Iterator<String> oldest = retiredTabs.iterator();
        while (retiredTabs.size() > RETIRED_TAB_LIMIT) { oldest.next(); oldest.remove(); }
    }

    /** Every reading session, including background tabs, for per-tab extension delegates. */
    private List<GeckoSession> sessions() {
        List<GeckoSession> result = new ArrayList<>();
        if (session != null) result.add(session);
        for (InAppBrowserSurfacePlugin tab : tabs.values()) if (tab.session != null) result.add(tab.session);
        return result;
    }

    @PluginMethod
    public void selectTab(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            selectedTab = call.getString("tabId");
            for (InAppBrowserSurfacePlugin tab : tabs.values()) {
                if (!tab.tabId.equals(selectedTab)) {
                    tab.setSurfaceVisible(false);
                    if (engine != null && tab.session != null && tab.session.isOpen()) engine.runtime.getWebExtensionController().setTabActive(tab.session, false);
                }
            }
            // The root's own surface serves unscoped calls while no tab is
            // selected; a selected tab must never share the screen with it.
            if (selectedTab != null) {
                if (visible) setSurfaceVisible(false);
                if (engine != null && session != null && session.isOpen()) engine.runtime.getWebExtensionController().setTabActive(session, false);
            }
            if (extensions != null) extensions.foregroundChanged();
            call.resolve();
        });
    }

    @Override
    protected void setSurfaceVisible(boolean visible) {
        super.setSurfaceVisible(visible && ownsForeground());
    }

    @Override
    protected boolean ownsForeground() { return owner == null ? selectedTab == null : tabId.equals(owner.selectedTab); }

    @Override
    protected GeckoSession createWindow(String url) {
        if (!isEmbeddable(url)) { openExternal(url); return null; }
        InAppBrowserSurfacePlugin root = owner == null ? this : owner;
        InAppBrowserSurfacePlugin tab = new InAppBrowserSurfacePlugin();
        tab.owner = root;
        tab.tabId = java.util.UUID.randomUUID().toString();
        tab.tabGeneration = java.util.UUID.randomUUID().toString();
        tab.setBridge(getBridge());
        tab.backgroundMedia = new BackgroundMedia(getContext());
        tab.ensureEngine();
        root.tabs.put(tab.tabId, tab);
        tab.navigationReady = true;
        tab.adoptedWindow = true;
        tab.openedByPage = true;
        tab.pageRequested = true;
        tab.requestedUrl = url;
        tab.currentUrl = url;
        tab.createReadingSession(false);
        // Gecko opens the returned session itself, preserving the opener.
        root.notifyListeners("newTabRequested", new JSObject().put("tabId", tab.tabId)
            .put("generation", tab.tabGeneration).put("url", url).put("navigationId", 0));
        return tab.session;
    }

    @Override
    protected void pageCloseRequested() {
        // The shell owns the tab list, so it decides how the tab goes away.
        if (owner != null && openedByPage) notifyListeners("closeRequested", new JSObject());
    }

    @Override
    protected void notifyListeners(String name, JSObject payload) {
        if (owner == null) { super.notifyListeners(name, payload); return; }
        if (owner.tabs.get(tabId) != this) return;
        payload.put("tabId", tabId);
        payload.put("generation", tabGeneration);
        owner.notifyListeners(name, payload);
    }

    @Override
    protected void handleOnStop() {
        super.handleOnStop();
        for (InAppBrowserSurfacePlugin tab : tabs.values()) tab.handleOnStop();
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        for (InAppBrowserSurfacePlugin tab : tabs.values()) tab.handleOnResume();
    }

    @Override
    void trimMemory(int level) {
        super.trimMemory(level);
        for (InAppBrowserSurfacePlugin tab : tabs.values()) tab.trimMemory(level);
    }

    @Override
    protected void handleOnDestroy() {
        for (InAppBrowserSurfacePlugin tab : new ArrayList<>(tabs.values())) {
            tab.destroyed = true;
            tab.destroySurface();
            tab.handler.removeCallbacksAndMessages(null);
        }
        tabs.clear();
        super.handleOnDestroy();
    }

    private final PageScriptCalls scripts = new PageScriptCalls(handler);
    private final ExtensionSettingsSync settings = new ExtensionSettingsSync(this);
    private boolean navigationReady;
    private static final String BRIDGE_NATIVE_APP = "once_surface";
    /** The story list does not need a second browser engine resident in memory. */
    @Override
    public void load() {
        getActivity().runOnUiThread(() -> backgroundMedia = new BackgroundMedia(getContext()));
    }

    private void ensureEngine() {
        if (engine != null) return;
        if (owner != null) {
            owner.ensureEngine();
            engine = owner.engine;
            extensions = owner.extensions;
            return;
        }
        engine = GeckoEngine.get(getContext());
        extensions = new GeckoExtensionManager(getActivity(), getBridge().getWebView(), engine, () -> {
            // The root's session is the reading page only while no tab is selected.
            if (selectedTab == null) return session;
            InAppBrowserSurfacePlugin tab = tabs.get(selectedTab);
            return tab == null ? null : tab.session;
        }, this::sessions,
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
        if (!route(call, Missing.CREATE, tab -> tab.open(call))) return;
        String url = call.getString("url");
        if (!isEmbeddable(url)) {
            call.reject("Embedded browsing only supports http and https URLs");
            return;
        }
        long request = requestedSequence.incrementAndGet();
        readyNavigation(call, () -> {
            if (request != requestedSequence.get()) { call.resolve(); return; }
            desktopSite.setEnabled(call.getBoolean("desktopSite", false));
            desktopSite.apply(session);
            ensureSurface();
            applyBounds(call.getObject("bounds", new JSObject()));
            setSurfaceVisible(call.getBoolean("visible", true));
            if (adoptedWindow) {
                // Gecko started loading the window before the shell listened to it.
                adoptedWindow = false;
                replayNavigation();
            } else requestNavigation(url);
            call.resolve();
        });
    }

    @PluginMethod
    public void navigate(PluginCall call) {
        if (!route(call, Missing.CREATE, tab -> tab.navigate(call))) return;
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
        if (!route(call, Missing.REJECT, tab -> tab.reload(call))) return;
        ready(call, () -> {
            reloadSession();
            call.resolve();
        });
    }

    /** Opens the app link the page redirected to (see navigationFailed's externalUrl). */
    @PluginMethod
    public void openExternalRedirect(PluginCall call) {
        if (!route(call, Missing.REJECT, tab -> tab.openExternalRedirect(call))) return;
        getActivity().runOnUiThread(() ->
            call.resolve(new JSObject().put("opened", openExternal(offeredExternalUrl))));
    }

    @PluginMethod
    public void goBack(PluginCall call) {
        if (!route(call, Missing.REJECT, tab -> tab.goBack(call))) return;
        getActivity().runOnUiThread(() -> {
            moveHistory(false);
            call.resolve();
        });
    }

    @PluginMethod
    public void goForward(PluginCall call) {
        if (!route(call, Missing.REJECT, tab -> tab.goForward(call))) return;
        getActivity().runOnUiThread(() -> {
            moveHistory(true);
            call.resolve();
        });
    }

    @PluginMethod
    public void goToHistoryIndex(PluginCall call) {
        if (!route(call, Missing.REJECT, tab -> tab.goToHistoryIndex(call))) return;
        getActivity().runOnUiThread(() -> {
            gotoHistory(call.getInt("index", -1));
            call.resolve();
        });
    }

    @PluginMethod
    public void capturePreview(PluginCall call) {
        if (!route(call, Missing.RESOLVE, tab -> tab.capturePreview(call))) return;
        getActivity().runOnUiThread(() -> ReadingPreview.capture(this, getBridge().getWebView(), call));
    }

    @PluginMethod
    public void setBounds(PluginCall call) {
        if (!route(call, Missing.RESOLVE, tab -> tab.setBounds(call))) return;
        getActivity().runOnUiThread(() -> {
            if (surface != null) applyBounds(call.getData());
            call.resolve();
        });
    }

    /** The shell frames the visible extension page: it draws the controls and reports the rectangle. */
    @PluginMethod
    public void extensionPage(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (extensions == null) { call.reject("Extensions are not ready"); return; }
            extensions.pages.handleCommand(call);
        });
    }

    @PluginMethod
    public void setVisible(PluginCall call) {
        if (!route(call, Missing.RESOLVE, tab -> tab.setVisible(call))) return;
        getActivity().runOnUiThread(() -> {
            setSurfaceVisible(call.getBoolean("visible", false));
            call.resolve();
        });
    }

    @PluginMethod
    public void showMenu(PluginCall call) {
        // A restored Reader-mode tab has no page yet but still owns its menu;
        // without a session the browser controls show disabled.
        if (!route(call, Missing.CREATE, tab -> tab.showMenu(call))) return;
        if (call.getBoolean("browserControls", false)) getActivity().runOnUiThread(() ->
            showBrowserMenu(call));
        else NativeSurfaceDialogs.showMenu(getBridge(), call);
    }

    /** Closes a browser sheet a row held open for its own menu, when the shell showed none after all. */
    @PluginMethod
    public void closeBrowserMenu(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            NativeBrowserMenu.closeHeld();
            call.resolve();
        });
    }

    /** The long-press menu for the shell's own Reader frame, which the system WebView draws none for. */
    @PluginMethod
    public void showContextMenu(PluginCall call) {
        String link = call.getString("link");
        String image = call.getString("image");
        LinkContextMenu.Target target = new LinkContextMenu.Target(link, call.getString("linkText"), image,
            image == null ? GeckoSession.ContentDelegate.ContextElement.TYPE_NONE : GeckoSession.ContentDelegate.ContextElement.TYPE_IMAGE,
            call.getString("referrer"));
        List<LinkContextMenu.Item> items = LinkContextMenu.Item.list(call.getArray("items"));
        getActivity().runOnUiThread(() -> {
            showLinkMenu(target, items);
            call.resolve();
        });
    }

    /** A page's long-press: the shell names its own items for the link before the menu opens. */
    @Override
    protected void showPageContextMenu(GeckoSession.ContentDelegate.ContextElement element) {
        LinkContextMenu.Target target = LinkContextMenu.Target.of(element);
        if (target.link == null) { showLinkMenu(target, new ArrayList<>()); return; }
        InAppBrowserSurfacePlugin root = owner != null ? owner : this;
        String requestId = java.util.UUID.randomUUID().toString();
        java.util.concurrent.atomic.AtomicBoolean shown = new java.util.concurrent.atomic.AtomicBoolean();
        java.util.function.Consumer<List<LinkContextMenu.Item>> show = items -> {
            if (shown.compareAndSet(false, true)) showLinkMenu(target, items);
        };
        root.pendingMenus.put(requestId, show);
        notifyListeners("contextMenuRequested", new JSObject().put("requestId", requestId)
            .put("link", target.link).put("linkText", target.linkText));
        // A shell that does not answer still gets its menu, without its items.
        handler.postDelayed(() -> {
            if (root.pendingMenus.remove(requestId) != null) show.accept(new ArrayList<>());
        }, MENU_ITEMS_TIMEOUT_MS);
    }

    /** The shell's answer to contextMenuRequested. */
    @PluginMethod
    public void setContextMenuItems(PluginCall call) {
        String requestId = call.getString("requestId", "");
        List<LinkContextMenu.Item> items = LinkContextMenu.Item.list(call.getArray("items"));
        getActivity().runOnUiThread(() -> {
            java.util.function.Consumer<List<LinkContextMenu.Item>> show = pendingMenus.remove(requestId);
            if (show != null) show.accept(items);
            call.resolve();
        });
    }

    private void showLinkMenu(LinkContextMenu.Target target, List<LinkContextMenu.Item> items) {
        LinkContextMenu.show(getActivity(), engine.runtime, target, items,
            (url, background) -> notifyListeners("openLinkRequested", new JSObject().put("url", url).put("background", background)),
            id -> notifyListeners("contextMenuAction", new JSObject().put("id", id)
                .put("link", target.link).put("linkText", target.linkText)));
    }

    /** With Reader-mode entries in its history, the shell owns Back and Forward. */
    private void showBrowserMenu(PluginCall call) {
        JSObject history = call.getObject("history", null);
        boolean back = history != null ? history.optBoolean("back") : canGoBack;
        boolean forward = history != null ? history.optBoolean("forward") : canGoForward;
        NativeBrowserMenu.show(getActivity(), call, session, back, forward,
            () -> { if (history != null) requestHistory("back"); else moveHistory(false); },
            () -> { if (history != null) requestHistory("forward"); else moveHistory(true); },
            this::reloadSession, backgroundMedia, desktopSite);
    }

    private void requestHistory(String direction) {
        notifyListeners("historyRequested", new JSObject().put("direction", direction));
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
        if (!route(call, Missing.REJECT, tab -> tab.evaluateJavaScript(call))) return;
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
            scripts.send(call, script, bridgePort);
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
            settings.apply(data);
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
        if (!route(call, Missing.REJECT, tab -> tab.findInPage(call))) return;
        getActivity().runOnUiThread(() -> ReadingPageFinder.find(call, session));
    }

    @PluginMethod
    public void clearFind(PluginCall call) {
        if (!route(call, Missing.RESOLVE, tab -> tab.clearFind(call))) return;
        getActivity().runOnUiThread(() -> {
            if (session != null) session.getFinder().clear();
            call.resolve();
        });
    }

    /** GeckoView has no find panel of its own; the shell's bar searches. */
    @PluginMethod
    public void presentFind(PluginCall call) {
        if (!route(call, Missing.REJECT, tab -> tab.presentFind(call))) return;
        call.resolve(new JSObject().put("presented", false));
    }

    @PluginMethod
    public void close(PluginCall call) {
        if (!route(call, Missing.RESOLVE, tab -> tab.close(call))) return;
        getActivity().runOnUiThread(() -> {
            // A closed tab never comes back: its identity is retired, so later
            // calls are rejected instead of rebuilding a session.
            if (owner != null) destroyed = true;
            destroySurface();
            if (owner != null) {
                owner.tabs.remove(tabId, this);
                owner.retire(tabId, tabGeneration);
                if (tabId.equals(owner.selectedTab)) owner.selectedTab = null;
            }
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
                    // Gecko starts extension background pages after the first
                    // session opens. Waiting for their settings acknowledgement
                    // before opening any session creates a 15-second timeout
                    // cycle. Bootstrap an empty session, but keep the requested
                    // URL behind the settings barrier.
                    if (session == null || !session.isOpen()) createReadingSession();
                } catch (RuntimeException error) { finishWaiting(call); call.reject("Browser operation failed", error); return; }
                // The engine starts with the first page, so the bridge receives
                // the synced filter lists only now. That page
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
        if (owner != null) { owner.whenExtensionSettingsApplied(work); return; }
        settings.whenApplied(work);
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
        bridgeExtension.setMessageDelegate(owner == null ? router : owner.new PortRouter(), BRIDGE_NATIVE_APP);
    }

    private final class PortRouter implements WebExtension.MessageDelegate {
        @Override
        public void onConnect(WebExtension.Port port) {
            int environment = port.sender.environmentType;
            if (environment == WebExtension.MessageSender.ENV_TYPE_EXTENSION) {
                settings.connected(port);
            } else if (environment == WebExtension.MessageSender.ENV_TYPE_CONTENT_SCRIPT
                && port.sender.session == session
                && port.sender.isTopLevel()) {
                bridgePort = port;
                healthSentAt = 0;
                nextHealthAt = 0;
                port.setDelegate(new BridgePort());
                backgroundMedia.attachPort(port);
                requestHealthCheck();
            }
        }
    }

    @Override
    protected void failPendingEvaluations(String reason) { scripts.failAll(reason); }

    private final class BridgePort implements WebExtension.PortDelegate {
        @Override
        public void onPortMessage(Object message, WebExtension.Port port) {
            if (!(message instanceof JSONObject)) return;
            JSONObject reply = (JSONObject) message;
            if (port != bridgePort) return;
            if ("health".equals(reply.optString("type"))) {
                if (reply.optLong("id", -1) != healthId || healthSentAt == 0) return;
                healthSentAt = 0;
                nextHealthAt = SystemClock.elapsedRealtime() + (navigationCompleted ? 5000 : 250);
                if (!awaitingRequestedStart && sameAddress(currentUrl, reply.optString("url"))) {
                    JSONObject context = reply.optJSONObject("context");
                    if (context != null) {
                        documentSourceUrl = context.optString("sourceUrl", documentSourceUrl);
                        documentStatus = context.optInt("statusCode", documentStatus);
                    }
                    String readyState = reply.optString("readyState");
                    // DOMContentLoaded plus visible paint is usable. Waiting for
                    // every image/tracker to finish needlessly kills healthy pages.
                    // BFCache restores do not always emit a new first-paint
                    // callback; keep their matching document acknowledgement.
                    if ((painted || reply.optBoolean("restored") || documentPainted && repairVerified)
                        && ("interactive".equals(readyState) || "complete".equals(readyState))) {
                        painted = true;
                        documentReady();
                    } else if ("complete".equals(readyState) && !painted) {
                        long now = SystemClock.elapsedRealtime();
                        if (blankSince == 0) blankSince = now;
                        if (!displayReattached && now - blankSince >= 750) repairDisplay();
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
            scripts.settle(reply);
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
}
