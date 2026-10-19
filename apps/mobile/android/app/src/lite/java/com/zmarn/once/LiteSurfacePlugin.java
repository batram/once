package com.zmarn.once;

import android.app.Activity;
import android.content.Intent;
import android.os.Looper;
import android.webkit.WebView;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.zmarn.once.lite.BrokerChannel;
import com.zmarn.once.lite.LiteExtensionEngine;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.json.JSONObject;

/**
 * Once Lite's reading surface: the system WebView beside the Capacitor shell,
 * under the same plugin name, methods, events and tab routing as the GeckoView
 * plugin (InAppBrowserSurfacePlugin), so the shell does not know which engine
 * it drives. Extensions come from the Lite runtime (LiteExtensionEngine): the
 * root plugin binds it to the activity, hands it the tabs it owns, and holds
 * each tab's first page behind the runtime's start and settings barriers.
 */
@CapacitorPlugin(name = "InAppBrowserSurface")
public class LiteSurfacePlugin extends LiteSurfaceHost implements ReadingSurfaceEngine {
    // Each child owns the complete recovery/media/navigation lifecycle of one page.
    // The registered plugin alone owns extension state and the shared profile.
    private LiteSurfacePlugin owner;
    private String tabId;
    private String tabGeneration;
    private String selectedTab;
    private boolean adoptedWindow;
    /** Opened by a page's window.open, so that page's script may close it again. */
    private boolean openedByPage;
    private final Map<String, LiteSurfacePlugin> tabs = new HashMap<>();
    // Only identities still likely to receive late calls need remembering.
    private final java.util.Set<String> retiredTabs = new java.util.LinkedHashSet<>();
    private static final int RETIRED_TAB_LIMIT = 256;
    private final TabRecency recency = new TabRecency();
    private LiteExtensionEngine extensions;
    private LiteExtensionPages pages;
    private static final long READY_TIMEOUT_MS = 30000;
    private final LiteFinder finder = new LiteFinder();
    private ImageFetcher images;

    /** What a call for a tab that has no runtime does: loads and menus create one. */
    private enum Missing { CREATE, RESOLVE, REJECT }
    /** Long-press menus waiting for the shell's items, by request; held by the root plugin. */
    private final Map<String, java.util.function.Consumer<List<LinkContextMenu.Item>>> pendingMenus = new HashMap<>();
    private static final long MENU_ITEMS_TIMEOUT_MS = 400;

    // Capacitor invokes plugin methods on its plugin thread, but the tab maps and
    // their views are UI-thread state. Returns true when the receiver should
    // run the call itself; otherwise the call was hopped, forwarded or settled.
    private boolean route(PluginCall call, Missing missing, java.util.function.Consumer<LiteSurfacePlugin> method) {
        if (owner != null) return true;
        if (Looper.myLooper() != Looper.getMainLooper()) {
            getActivity().runOnUiThread(() -> method.accept(this));
            return false;
        }
        LiteSurfacePlugin target = target(call, missing);
        if (target == this) return true;
        if (target != null) method.accept(target);
        return false;
    }

    private LiteSurfacePlugin target(PluginCall call, Missing missing) {
        if (owner != null) return this;
        String id = call.getString("tabId", selectedTab);
        if (id == null) return this;
        String generation = call.getString("generation", "");
        LiteSurfacePlugin tab = tabs.get(id);
        if (tab != null && (generation.isEmpty() || generation.equals(tab.tabGeneration))) return tab;
        if (missing == Missing.RESOLVE) { call.resolve(); return null; }
        if (retiredTabs.contains(id + ":" + generation)) {
            call.reject("The tab runtime was closed");
            return null;
        }
        if (missing == Missing.REJECT) { call.reject("No such tab"); return null; }
        if (tab != null) {
            LiteSurfacePlugin previous = tab;
            retire(id, previous.tabGeneration);
            previous.destroyed = true;
            getActivity().runOnUiThread(previous::destroySurface);
        }
        return newTab(id, generation);
    }

    /** A tab runtime of this root plugin, registered under its identity. */
    private LiteSurfacePlugin newTab(String id, String generation) {
        LiteSurfacePlugin tab = new LiteSurfacePlugin();
        tab.owner = this;
        tab.tabId = id;
        tab.tabGeneration = generation;
        tab.setBridge(getBridge());
        tab.backgroundMedia = new LiteBackgroundMedia(getContext());
        tab.bindMedia();
        recency.used(tab);
        tabs.put(id, tab);
        return tab;
    }

    private void retire(String id, String generation) {
        retiredTabs.remove(id + ":" + generation);
        retiredTabs.add(id + ":" + generation);
        java.util.Iterator<String> oldest = retiredTabs.iterator();
        while (retiredTabs.size() > RETIRED_TAB_LIMIT) { oldest.next(); oldest.remove(); }
    }

    private void bindMedia() {
        backgroundMedia.playingChanged = playing -> notifyListeners("mediaStateChanged", new JSObject().put("playing", playing));
        backgroundMedia.presentationChanged = video::update;
    }

    private LiteSurfacePlugin root() { return owner == null ? this : owner; }

    private ImageFetcher images() {
        LiteSurfacePlugin root = root();
        if (root.images == null) root.images = new LiteImageFetcher(getContext());
        return root.images;
    }

    /** Every page view, including background tabs, for profile-wide clearing. */
    private List<WebView> views() {
        List<WebView> result = new ArrayList<>();
        if (surface != null) result.add(surface);
        for (LiteSurfacePlugin tab : tabs.values()) if (tab.surface != null) result.add(tab.surface);
        return result;
    }

    @Override
    public void load() {
        getActivity().runOnUiThread(() -> {
            backgroundMedia = new LiteBackgroundMedia(getContext());
            bindMedia();
            ensureExtensions();
        });
    }

    private void ensureExtensions() {
        if (owner != null) { owner.ensureExtensions(); extensions = owner.extensions; pages = owner.pages; return; }
        if (extensions != null) return;
        extensions = LiteExtensionEngine.get(getContext());
        pages = new LiteExtensionPages(getActivity(), () -> getBridge().getWebView(), () -> extensions,
            payload -> notifyListeners("extensionPageChanged", payload));
        WebView shell = getBridge().getWebView();
        extensions.bind(getActivity(), (android.view.ViewGroup) shell.getParent(), new TabShell(), pages, new LiteExtensionEngine.Listener() {
            @Override public void extensionsChanged() { notifyListeners("extensionsChanged", new JSObject()); }
            @Override public void violentmonkeyConnected() { LiteViolentmonkeyPlugin.connected(); }
            @Override public void violentmonkeyDashboardChanged() { LiteViolentmonkeyPlugin.dashboardChanged(); }
        });
    }

    @Override protected LiteExtensionEngine engine() { ensureExtensions(); return extensions; }
    @Override protected boolean adoptingWindow() { return adoptedWindow; }
    @Override protected int tabIndex() { return owner == null ? 0 : new ArrayList<>(owner.tabs.keySet()).indexOf(tabId); }

    /** The runtime's `tab.*` requests, answered with the shell's own tab flow (as window.open is). */
    private final class TabShell implements LiteExtensionEngine.TabShell {
        private LiteSurfacePlugin find(int id) {
            if (liteTabId == id) return LiteSurfacePlugin.this;
            for (LiteSurfacePlugin tab : tabs.values()) if (tab.liteTabId == id) return tab;
            return null;
        }
        @Override public int createTab(String url, boolean active) {
            if (!ReadingAddress.embeddable(url)) { openExternal(url); return -1; }
            LiteSurfacePlugin tab = newTab(java.util.UUID.randomUUID().toString(), java.util.UUID.randomUUID().toString());
            tab.ensureExtensions();
            // The shell hears of the tab as it does of a window, and finds it loading when it opens it.
            tab.adoptedWindow = true;
            tab.pageRequested = true;
            tab.ensureSurface();
            tab.requestNavigation(url);
            tab.announceWindow(url);
            return tab.liteTabId;
        }
        @Override public void updateTab(int id, JSONObject params) {
            LiteSurfacePlugin tab = find(id);
            if (tab == null || tab.surface == null) return;
            String url = params.optString("url", "");
            if (!url.isEmpty() && ReadingAddress.embeddable(url)) { tab.requestedSequence.incrementAndGet(); tab.requestNavigation(url); }
        }
        @Override public void removeTab(int id) {
            LiteSurfacePlugin tab = find(id);
            if (tab != null && tab.owner != null) tab.notifyListeners("closeRequested", new JSObject());
        }
        @Override public void reloadTab(int id) {
            LiteSurfacePlugin tab = find(id);
            if (tab != null) tab.reloadSession();
        }
    }

    @PluginMethod
    public void selectTab(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            selectedTab = call.getString("tabId");
            for (LiteSurfacePlugin tab : tabs.values()) {
                if (!tab.tabId.equals(selectedTab)) tab.setSurfaceVisible(false);
                tab.reportTab();
            }
            // The root's own surface serves unscoped calls while no tab is
            // selected; a selected tab must never share the screen with it.
            if (selectedTab != null && visible) setSurfaceVisible(false);
            recency.selected(tabs.values(), selectedTab == null ? null : tabs.get(selectedTab));
            call.resolve();
        });
    }

    @Override
    protected void setSurfaceVisible(boolean visible) {
        super.setSurfaceVisible(visible && ownsForeground());
    }

    @Override
    protected boolean ownsForeground() { return owner == null ? selectedTab == null : tabId.equals(owner.selectedTab); }

    /**
     * window.open: a tab of the shell's with its own view, handed to Chromium as
     * the window's transport. With the address known (a tapped link) the shell
     * hears of the tab now; a scripted open names it when the view starts loading.
     */
    @Override
    protected WebView createWindow(String url) {
        if (url != null && !ReadingAddress.embeddable(url)) { openExternal(url); return null; }
        LiteSurfacePlugin root = root();
        LiteSurfacePlugin tab = root.newTab(java.util.UUID.randomUUID().toString(), java.util.UUID.randomUUID().toString());
        tab.ensureExtensions();
        tab.adoptedWindow = true;
        tab.openedByPage = true;
        tab.pageRequested = true;
        tab.ensureSurface();
        if (url != null) tab.announceWindow(url);
        return tab.surface;
    }

    private boolean announced;

    private void announceWindow(String url) {
        if (announced) return;
        announced = true;
        requestedUrl = url;
        currentUrl = url;
        root().notifyListeners("newTabRequested", new JSObject().put("tabId", tabId)
            .put("generation", tabGeneration).put("url", url).put("navigationId", 0));
    }

    @Override
    protected void pageStarted(String url) {
        if (adoptedWindow && !announced) {
            if (!ReadingAddress.embeddable(url)) {
                // The window went straight to another app; there is nothing to show.
                openExternal(url);
                destroyed = true;
                destroySurface();
                if (owner != null) { owner.tabs.remove(tabId, this); owner.retire(tabId, tabGeneration); }
                return;
            }
            announceWindow(url);
        }
        super.pageStarted(url);
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
        for (LiteSurfacePlugin tab : tabs.values()) tab.handleOnStop();
        if (pages != null) pages.setResumed(false);
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        for (LiteSurfacePlugin tab : tabs.values()) tab.handleOnResume();
        if (pages != null) pages.setResumed(true);
    }

    @Override
    public void trimMemory(int level) {
        super.trimMemory(level);
        for (LiteSurfacePlugin tab : tabs.values()) tab.trimMemory(level);
        if (pages != null) pages.trimHidden();
    }

    /** WebView debugging stays on: the Lite runtime needs the DevTools socket (see EngineSurface). */
    @Override
    public void setRemoteDebugging(boolean allowed) { WebView.setWebContentsDebuggingEnabled(true); }

    /**
     * The shell page restarted in a new renderer and remembers nothing it had
     * shown. Pages are hidden, views kept, until it opens its tabs again.
     */
    @Override
    public void shellRestarted() {
        for (LiteSurfacePlugin tab : tabs.values()) tab.setSurfaceVisible(false);
        setSurfaceVisible(false);
        if (pages != null) pages.closeVisible();
    }

    @Override
    protected void handleOnDestroy() {
        for (LiteSurfacePlugin tab : new ArrayList<>(tabs.values())) {
            tab.destroyed = true;
            tab.destroySurface();
            tab.handler.removeCallbacksAndMessages(null);
        }
        tabs.clear();
        if (pages != null) pages.destroy();
        if (extensions != null) extensions.unbind(getActivity());
        super.handleOnDestroy();
    }

    // Every tab shares the one WebView profile, so clearing belongs to the
    // root plugin, not a tab. Capacitor finds inherited @PluginMethods too.
    @PluginMethod
    public void clearSiteData(PluginCall call) { getActivity().runOnUiThread(() -> LiteBrowsingData.clearSite(getActivity(), call)); }

    @PluginMethod
    public void clearAllData(PluginCall call) { getActivity().runOnUiThread(() -> LiteBrowsingData.clearAll(getActivity(), root().views(), call)); }

    @PluginMethod
    public void extensionCommand(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            ensureExtensions();
            if ("chooseFile".equals(call.getString("action"))) {
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                startActivityForResult(call, intent, "extensionFileChosen");
            } else command(call, call.getData());
        });
    }

    @ActivityCallback
    private void extensionFileChosen(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            call.resolve(new JSObject().put("cancelled", true));
            return;
        }
        JSONObject params = new JSObject().put("action", "chooseFile").put("file", result.getData().getData().toString());
        getActivity().runOnUiThread(() -> { ensureExtensions(); command(call, params); });
    }

    /** The shell's command, answered by the broker in the shell's own shape. */
    private void command(PluginCall call, JSONObject params) {
        extensions.command(params).whenComplete((result, error) -> {
            if (error == null) {
                try { call.resolve(new JSObject(result.toString())); }
                catch (org.json.JSONException failure) { call.reject("Unable to read the answer", failure); }
                return;
            }
            Throwable cause = error instanceof java.util.concurrent.CompletionException && error.getCause() != null ? error.getCause() : error;
            String code = cause instanceof BrokerChannel.BrokerError ? ((BrokerChannel.BrokerError) cause).code : null;
            String message = cause.getMessage() == null ? "Extension operation failed" : cause.getMessage();
            if (code != null) call.reject(message, code); else call.reject(message);
        });
    }

    @PluginMethod
    public void open(PluginCall call) {
        if (!route(call, Missing.CREATE, tab -> tab.open(call))) return;
        String url = call.getString("url");
        if (!ReadingAddress.embeddable(url)) {
            call.reject("Embedded browsing only supports http and https URLs");
            return;
        }
        long request = requestedSequence.incrementAndGet();
        ready(call, () -> {
            if (request != requestedSequence.get()) { call.resolve(); return; }
            desktopSite.setEnabled(call.getBoolean("desktopSite", false));
            ensureSurface();
            LiteNavigation.applyDesktopSite(surface, desktopSite.isEnabled());
            applyBounds(call.getObject("bounds", new JSObject()));
            setSurfaceVisible(call.getBoolean("visible", true));
            if (adoptedWindow) {
                // Chromium started loading the window before the shell listened to it.
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
        if (!ReadingAddress.embeddable(url)) {
            call.reject("Embedded browsing only supports http and https URLs");
            return;
        }
        long request = requestedSequence.incrementAndGet();
        ready(call, () -> {
            if (request != requestedSequence.get()) { call.resolve(); return; }
            ensureSurface();
            requestNavigation(url);
            call.resolve();
        });
    }

    /** Reader's bounded document download; see DocumentDownload. */
    @PluginMethod
    public void fetchDocument(PluginCall call) { DocumentDownload.fetch(call); }

    /** On-device OCR for the shell's text retrieval; see TextRecognition. */
    @PluginMethod
    public void recognizeImage(PluginCall call) { TextRecognition.recognize(call, call.getString("url") == null ? null : images()); }

    /** This tab's image text selection, as far as the app shows it natively (its bar); a page is its bridge document token. */
    private final ImageTextOverlays imageTexts = new ImageTextOverlays(this::getActivity, () -> surfaceContent, () -> visible ? surface : null,
        bridge::token, (code, token) -> bridge.post(code, token), (code, token, answer) -> bridge.request(code, token, answer),
        image -> notifyListeners("contextMenuAction", new JSObject()
            .put("id", LinkContextMenu.IMAGE_TEXT).put("image", image.optString("image")).put("referrer", image.optString("referrer"))));

    @Override protected boolean bridgeMessage(JSONObject message, Object token) { return imageTexts.receive(message, token); }

    @PluginMethod
    public void imageTextOverlay(PluginCall call) {
        if (!route(call, Missing.REJECT, tab -> tab.imageTextOverlay(call))) return;
        getActivity().runOnUiThread(() -> imageTexts.command(call));
    }

    @Override
    protected void failPendingEvaluations(String reason) { bridge.failAll(reason); imageTexts.close(); }

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
        getActivity().runOnUiThread(() -> { moveHistory(false); call.resolve(); });
    }

    @PluginMethod
    public void goForward(PluginCall call) {
        if (!route(call, Missing.REJECT, tab -> tab.goForward(call))) return;
        getActivity().runOnUiThread(() -> { moveHistory(true); call.resolve(); });
    }

    @PluginMethod
    public void goToHistoryIndex(PluginCall call) {
        if (!route(call, Missing.REJECT, tab -> tab.goToHistoryIndex(call))) return;
        getActivity().runOnUiThread(() -> { gotoHistory(call.getInt("index", -1)); call.resolve(); });
    }

    @PluginMethod
    public void capturePreview(PluginCall call) {
        if (!route(call, Missing.RESOLVE, tab -> tab.capturePreview(call))) return;
        getActivity().runOnUiThread(() -> ReadingPreview.capture(new ReadingPreview.PageCapture() {
            @Override public boolean available() { return surface != null && surface.isShown() && committedNavigation == activeNavigation; }
            @Override public void capture(java.util.function.Consumer<android.graphics.Bitmap> image, Runnable failed) {
                image.accept(ReadingPreview.draw(surface));
            }
        }, getBridge().getWebView(), call));
    }

    @PluginMethod
    public void setBounds(PluginCall call) {
        if (!route(call, Missing.RESOLVE, tab -> tab.setBounds(call))) return;
        getActivity().runOnUiThread(() -> {
            if (refreshSurface != null) applyBounds(call.getData());
            call.resolve();
        });
    }

    /** The shell frames the visible extension page: it draws the controls and reports the rectangle. */
    @PluginMethod
    public void extensionPage(PluginCall call) {
        getActivity().runOnUiThread(() -> { ensureExtensions(); pages.handleCommand(call); });
    }

    @PluginMethod
    public void setVisible(PluginCall call) {
        if (!route(call, Missing.RESOLVE, tab -> tab.setVisible(call))) return;
        getActivity().runOnUiThread(() -> {
            display.show(call.getBoolean("visible", false), call.getBoolean("covered", false));
            call.resolve();
        });
    }

    @PluginMethod
    public void showMenu(PluginCall call) {
        // A restored Reader-mode tab has no page yet but still owns its menu;
        // without a page the browser controls show disabled.
        if (!route(call, Missing.CREATE, tab -> tab.showMenu(call))) return;
        if (call.getBoolean("browserControls", false)) getActivity().runOnUiThread(() -> showBrowserMenu(call));
        else NativeSurfaceDialogs.showMenu(getBridge(), call);
    }

    /** Closes a browser sheet a row held open for its own menu, when the shell showed none after all. */
    @PluginMethod
    public void closeBrowserMenu(PluginCall call) {
        getActivity().runOnUiThread(() -> { NativeBrowserMenu.closeHeld(); call.resolve(); });
    }

    /** The long-press menu for the shell's own Reader frame, which the system WebView draws none for. */
    @PluginMethod
    public void showContextMenu(PluginCall call) {
        String link = call.getString("link");
        String image = call.getString("image");
        LinkContextMenu.Target target = new LinkContextMenu.Target(link, call.getString("linkText"), image,
            image == null ? LinkContextMenu.Target.TYPE_NONE : LinkContextMenu.Target.TYPE_IMAGE, call.getString("referrer"), false);
        List<LinkContextMenu.Item> items = LinkContextMenu.Item.list(call.getArray("items"));
        getActivity().runOnUiThread(() -> { showLinkMenu(target, items); call.resolve(); });
    }

    /** A page's long-press: the shell names its own items for the link before the menu opens. */
    @Override
    protected void showPageContextMenu(LinkContextMenu.Target target) {
        if (target.link == null) { showLinkMenu(target, new ArrayList<>()); return; }
        LiteSurfacePlugin root = root();
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
        LinkContextMenu.show(getActivity(), images(), target, items,
            (url, background) -> notifyListeners("openLinkRequested", new JSObject().put("url", url).put("background", background)),
            id -> notifyListeners("contextMenuAction", new JSObject().put("id", id)
                .put("link", target.link).put("linkText", target.linkText).put("image", target.media).put("referrer", target.referrer)));
    }

    /** With Reader-mode entries in its history, the shell owns Back and Forward. */
    private void showBrowserMenu(PluginCall call) {
        JSObject history = call.getObject("history", null);
        boolean back = history != null ? history.optBoolean("back") : canGoBack;
        boolean forward = history != null ? history.optBoolean("forward") : canGoForward;
        NativeBrowserMenu.show(getActivity(), call, surface != null, surface != null, back, forward,
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
     * Runs the script in the page's Once-owned bridge world (once-bridge) and
     * answers with its JSON-encoded result, as the GeckoView bridge extension
     * does; without DevTools (Tier 2) the page's main world runs it.
     */
    @PluginMethod
    public void evaluateJavaScript(PluginCall call) {
        if (!route(call, Missing.REJECT, tab -> tab.evaluateJavaScript(call))) return;
        String script = call.getString("script");
        getActivity().runOnUiThread(() -> {
            if (script == null || script.isEmpty()) { call.reject("JavaScript source is required"); return; }
            if (surface == null) { call.reject("There is no open page"); return; }
            if (engine().devtoolsAvailable()) {
                bridge.evaluate(script, new com.zmarn.once.lite.LiteBridge.Reply() {
                    @Override public void resolve(String value) { call.resolve(new JSObject().put("value", value)); }
                    @Override public void reject(String message) { call.reject(message); }
                });
                return;
            }
            if (committedNavigation != activeNavigation) { call.reject("The page is not ready to run scripts"); return; }
            surface.evaluateJavascript(script, value -> call.resolve(new JSObject().put("value", value == null ? "null" : value)));
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
            ensureExtensions();
            extensions.applySettings(data).whenComplete((ignored, error) -> {
                if (error == null) call.resolve(); else call.reject("Extension settings were not applied: " + error.getMessage());
            });
        });
    }

    @PluginMethod
    public void findInPage(PluginCall call) {
        if (!route(call, Missing.REJECT, tab -> tab.findInPage(call))) return;
        getActivity().runOnUiThread(() -> finder.find(call, surface));
    }

    @PluginMethod
    public void clearFind(PluginCall call) {
        if (!route(call, Missing.RESOLVE, tab -> tab.clearFind(call))) return;
        getActivity().runOnUiThread(() -> { finder.clear(surface); call.resolve(); });
    }

    /** The WebView has no find panel of its own; the shell's bar searches. */
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
            // calls are rejected instead of rebuilding a view.
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

    /**
     * Like the GeckoView plugin's barrier: the first page waits until the
     * broker answered `lite.start` and acknowledged the synced settings
     * (bounded), so a document that starts earlier is neither filtered nor
     * scripted. The Violentmonkey hand-off hold is the broker's own.
     */
    private void ready(PluginCall call, Runnable work) {
        getActivity().runOnUiThread(() -> {
            if (destroyed) { call.reject("The browser host was closed"); return; }
            ensureExtensions();
            if (extensions.isStarted()) { settled(call, work); return; }
            if (waiting.size() >= 16) { call.reject("Too many pending browser operations"); return; }
            long generation = surfaceGeneration;
            Runnable timeout = () -> {
                if (waiting.remove(call) != null) call.reject("Browser extensions did not become ready in time. Try again.");
            };
            waiting.put(call, timeout);
            handler.postDelayed(timeout, READY_TIMEOUT_MS);
            extensions.whenStarted(READY_TIMEOUT_MS, () -> {
                Runnable pending = waiting.remove(call);
                if (pending == null) return;
                handler.removeCallbacks(pending);
                if (destroyed || generation != surfaceGeneration) { call.reject("The browser surface was closed"); return; }
                settled(call, work);
            });
        });
    }

    private void settled(PluginCall call, Runnable work) {
        long generation = surfaceGeneration;
        extensions.whenSettingsApplied(() -> {
            if (destroyed || generation != surfaceGeneration) { call.reject("The browser surface was closed"); return; }
            try { work.run(); } catch (RuntimeException error) { call.reject("Browser operation failed", error); }
        });
    }
}
