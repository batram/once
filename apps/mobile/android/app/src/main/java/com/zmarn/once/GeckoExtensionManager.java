package com.zmarn.once;

import android.app.Activity;
import android.app.AlertDialog;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Supplier;
import org.mozilla.geckoview.AllowOrDeny;
import org.mozilla.geckoview.GeckoResult;
import org.mozilla.geckoview.GeckoSession;
import org.mozilla.geckoview.WebExtension;
import org.mozilla.geckoview.WebExtensionController;

/** Activity-owned management, permissions, actions and extension-created sessions. */
final class GeckoExtensionManager implements WebExtension.ActionDelegate, WebExtension.TabDelegate {
    private final Activity activity;
    final GeckoEngine engine;
    final GeckoExtensionPages pages;
    private final Supplier<GeckoSession> reading;
    private final Runnable changed;
    private final Map<String, WebExtension> extensions = new LinkedHashMap<>();
    private final Map<String, WebExtension.Action> actions = new HashMap<>();
    private final GeckoExtensionIcons icons;
    private final Map<GeckoSession, Map<String, WebExtension.Action>> tabActions = new HashMap<>();
    private final Map<AlertDialog, GeckoResult<AllowOrDeny>> prompts = new HashMap<>();
    private final ExecutorService downloads = Executors.newSingleThreadExecutor();
    private boolean disposed;
    private boolean readingVisible;
    private GeckoSession popupContext;
    private PluginCall operation;
    private boolean declined;

    GeckoExtensionManager(Activity activity, GeckoEngine engine, Supplier<GeckoSession> reading, Runnable changed) {
        this.activity = activity;
        this.engine = engine;
        this.reading = reading;
        this.changed = changed;
        icons = new GeckoExtensionIcons(() -> { if (!disposed) changed.run(); });
        pages = new GeckoExtensionPages(activity, engine, this);
        engine.runtime.getWebExtensionController().setPromptDelegate(new Prompts());
    }

    void adopt(List<WebExtension> installed) {
        if (disposed) return;
        extensions.clear();
        for (WebExtension extension : installed) {
            extensions.put(extension.id, extension);
            extension.setTabDelegate(this);
            extension.setActionDelegate(this);
            if (reading.get() != null) attachSessionExtension(reading.get(), extension);
            pages.attach(extension);
        }
        actions.keySet().retainAll(extensions.keySet());
        icons.adopt(installed);
    }

    WebExtension bridge() { return extensions.get(GeckoEngine.BRIDGE_ID); }

    void attachSession(GeckoSession session) {
        for (WebExtension extension : extensions.values()) attachSessionExtension(session, extension);
    }

    void forgetSession(GeckoSession session) {
        tabActions.remove(session);
        if (popupContext == session) popupContext = null;
    }

    void attachSessionExtension(GeckoSession session, WebExtension extension) {
        session.getWebExtensionController().setActionDelegate(extension, this);
        session.getWebExtensionController().setTabDelegate(extension, new WebExtension.SessionTabDelegate() {
            @Override public GeckoResult<AllowOrDeny> onUpdateTab(WebExtension source, GeckoSession target, WebExtension.UpdateTabDetails details) {
                if (details.url != null && !GeckoExtensionPages.allowed(details.url)) return GeckoResult.deny();
                if (Boolean.TRUE.equals(details.active)) pages.show(target);
                // Gecko performs the navigation after ALLOW; loading it here would navigate twice.
                return GeckoResult.allow();
            }
            @Override public GeckoResult<AllowOrDeny> onCloseTab(WebExtension source, GeckoSession target) {
                if (!pages.contains(target)) return GeckoResult.deny();
                pages.close(target);
                forgetSession(target);
                return GeckoResult.allow();
            }
        });
    }

    void setReadingVisible(boolean value) { readingVisible = value; foregroundChanged(); }

    void foregroundChanged() {
        GeckoSession page = reading.get();
        GeckoSession foreground = pages.hasPopup() ? popupContext : pages.foregroundTab();
        if (page != null && page.isOpen()) engine.runtime.getWebExtensionController().setTabActive(page,
            foreground == page || (foreground == null && readingVisible));
        if (foreground != null && foreground.isOpen()) engine.runtime.getWebExtensionController().setTabActive(foreground, true);
    }

    @Override public GeckoResult<GeckoSession> onNewTab(WebExtension source, WebExtension.CreateTabDetails details) {
        if (disposed || !GeckoExtensionPages.allowed(details.url)) return GeckoResult.fromValue(null);
        try { return GeckoResult.fromValue(pages.create(source.id, source.metaData.name, false, !Boolean.FALSE.equals(details.active))); }
        catch (RuntimeException error) { return GeckoResult.fromException(error); }
    }

    @Override public void onOpenOptionsPage(WebExtension extension) {
        if (!disposed && extension.metaData.optionsPageUrl != null) pages.open(extension, extension.metaData.optionsPageUrl);
    }

    @Override public void onBrowserAction(WebExtension extension, GeckoSession session, WebExtension.Action action) {
        boolean first = session == null && !actions.containsKey(extension.id);
        if (session == null) actions.put(extension.id, action);
        else tabActions.computeIfAbsent(session, ignored -> new HashMap<>()).put(extension.id, action);
        if (first) changed.run();
    }

    @Override public GeckoResult<GeckoSession> onOpenPopup(WebExtension extension, WebExtension.Action action) {
        if (disposed) return GeckoResult.fromValue(null);
        try {
            if (popupContext == null) popupContext = reading.get();
            GeckoSession popup = pages.create(extension.id, extension.metaData.name, true, true);
            popup.open(engine.runtime);
            return GeckoResult.fromValue(popup);
        }
        catch (RuntimeException error) { return GeckoResult.fromException(error); }
    }

    @Override public GeckoResult<GeckoSession> onTogglePopup(WebExtension extension, WebExtension.Action action) {
        return onOpenPopup(extension, action);
    }

    void command(PluginCall call) {
        if (disposed) { call.reject("The browser host was closed"); return; }
        String action = call.getString("action", "list");
        if (operation != null) { call.reject("An extension operation is already in progress"); return; }
        operation = call;
        declined = false;
        engine.ready().then(ignored -> engine.runtime.getWebExtensionController().list()).accept(installed -> {
            if (disposed) return;
            adopt(installed);
            try { execute(call, action); }
            catch (Exception error) { fail(call, error); }
        }, error -> fail(call, error));
    }

    private void execute(PluginCall call, String action) throws Exception {
        if ("list".equals(action)) { succeed(call, catalog()); return; }
        if ("install".equals(action)) {
            String source = call.getString("source", "");
            downloads.execute(() -> {
                try {
                    String url = GeckoExtensionSource.resolve(source);
                    activity.runOnUiThread(() -> install(call, url, null));
                } catch (Exception error) { activity.runOnUiThread(() -> fail(call, error)); }
            });
            return;
        }
        String id = call.getString("id", "");
        WebExtension extension = extensions.get(id);
        if (extension == null || GeckoEngine.BRIDGE_ID.equals(id)) throw new IllegalArgumentException("Extension not found");
        WebExtensionController controller = engine.runtime.getWebExtensionController();
        if ("enable".equals(action)) {
            boolean enabled = call.getBoolean("enabled", true);
            if (!enabled) pages.closeOwner(id);
            finish(call, enabled ? controller.enable(extension, WebExtensionController.EnableSource.USER) :
                controller.disable(extension, WebExtensionController.EnableSource.USER));
        } else if ("remove".equals(action)) {
            if (GeckoEngine.bundled(id)) throw new IllegalArgumentException("Included extensions can be disabled, but not removed");
            pages.closeOwner(id);
            finish(call, controller.uninstall(extension));
        } else if ("update".equals(action)) {
            if (GeckoEngine.bundled(id)) throw new IllegalArgumentException("Included extensions update with Once");
            finish(call, controller.update(extension));
        } else if ("options".equals(action)) {
            if (!extension.metaData.enabled) throw new IllegalStateException("Enable the extension first");
            if (extension.metaData.optionsPageUrl != null) onOpenOptionsPage(extension);
            else click(extension);
            succeed(call, new JSObject());
        } else if ("action".equals(action)) {
            if (!extension.metaData.enabled) throw new IllegalStateException("Enable the extension first");
            if (actionTab() == null) {
                // Without a page there is nothing to act on, so fall back to the
                // extension's own settings; the shell opens its manager otherwise.
                if (extension.metaData.optionsPageUrl != null) onOpenOptionsPage(extension);
                succeed(call, new JSObject().put("noPage", extension.metaData.optionsPageUrl == null));
                return;
            }
            click(extension);
            succeed(call, new JSObject());
        } else throw new IllegalArgumentException("Unknown extension operation");
    }

    private GeckoSession actionTab() {
        GeckoSession tab = pages.foregroundTab() != null ? pages.foregroundTab() : reading.get();
        return tab != null && tab.isOpen() ? tab : null;
    }

    private void click(WebExtension extension) {
        WebExtension.Action action = actions.get(extension.id);
        GeckoSession tab = actionTab();
        if (tab == null) throw new IllegalStateException("Open a reading page before using this extension action");
        WebExtension.Action override = tabActions.getOrDefault(tab, new HashMap<>()).get(extension.id);
        if (override != null) action = action == null ? override : override.withDefault(action);
        if (action == null || Boolean.FALSE.equals(action.enabled)) throw new IllegalStateException("This extension has no available action on the current page");
        popupContext = tab;
        engine.runtime.getWebExtensionController().setTabActive(tab, true);
        action.click();
    }

    void installFile(PluginCall call, java.io.File file) {
        if (disposed || operation != null) { file.delete(); call.reject("The extension manager is busy or closed"); return; }
        operation = call;
        declined = false;
        engine.ready().accept(ignored -> install(call, file.toURI().toString(), file), error -> { file.delete(); fail(call, error); });
    }

    private void install(PluginCall call, String url, java.io.File temporary) {
        if (disposed) { if (temporary != null) temporary.delete(); return; }
        GeckoResult<WebExtension> result = engine.runtime.getWebExtensionController().install(url);
        result.finally_(() -> { if (temporary != null) temporary.delete(); });
        finish(call, result);
    }

    private void finish(PluginCall call, GeckoResult<?> result) {
        result.then(ignored -> engine.runtime.getWebExtensionController().list()).accept(installed -> {
            if (disposed) return;
            adopt(installed);
            succeed(call, catalog());
            changed.run();
        }, error -> fail(call, error));
    }

    private JSObject catalog() {
        JSArray items = new JSArray();
        for (WebExtension extension : extensions.values()) {
            if (GeckoEngine.BRIDGE_ID.equals(extension.id) || extension.metaData == null) continue;
            WebExtension.MetaData meta = extension.metaData;
            JSObject item = new JSObject();
            item.put("id", extension.id);
            item.put("name", meta.name);
            item.put("iconDataUrl", icons.get(extension));
            item.put("description", meta.description);
            item.put("version", meta.version);
            item.put("enabled", meta.enabled);
            item.put("bundled", GeckoEngine.bundled(extension.id));
            item.put("hasOptions", meta.optionsPageUrl != null);
            item.put("hasAction", actions.containsKey(extension.id));
            item.put("permissions", new JSArray(access(meta.requiredPermissions, meta.requiredOrigins, meta.requiredDataCollectionPermissions)));
            item.put("disabledReason", meta.enabled ? "" : "Disabled (Gecko flags: " + meta.disabledFlags + ")");
            items.put(item);
        }
        JSObject result = new JSObject();
        result.put("extensions", items);
        return result;
    }

    private void succeed(PluginCall call, JSObject result) { if (operation == call) { operation = null; call.resolve(result); } }
    private void fail(PluginCall call, Throwable error) {
        if (operation != call) return;
        if (declined) { succeed(call, new JSObject().put("cancelled", true)); return; }
        operation = null;
        String detail = error.getMessage();
        call.reject("Extension operation failed: " + (detail == null ? error.toString() : detail));
    }

    private static List<String> access(String[] permissions, String[] origins, String[] data) {
        List<String> result = new ArrayList<>();
        if (permissions != null) java.util.Collections.addAll(result, permissions);
        if (origins != null) java.util.Collections.addAll(result, origins);
        if (data != null) for (String value : data) result.add("Data collection: " + value);
        return result;
    }

    private GeckoResult<AllowOrDeny> prompt(WebExtension extension, String title, String[] permissions, String[] origins, String[] data) {
        if (disposed) return GeckoResult.deny();
        GeckoResult<AllowOrDeny> result = new GeckoResult<>();
        List<String> requested = access(permissions, origins, data);
        AlertDialog dialog = new AlertDialog.Builder(activity)
            .setTitle(title + " " + extension.metaData.name)
            .setMessage("Version " + extension.metaData.version + "\n" + extension.id + "\n\nRequested access:\n" +
                (requested.isEmpty() ? "No additional permissions" : String.join("\n", requested)))
            .setPositiveButton("Allow", (window, which) -> result.complete(AllowOrDeny.ALLOW))
            .setNegativeButton("Cancel", (window, which) -> { declined = true; result.complete(AllowOrDeny.DENY); })
            .create();
        prompts.put(dialog, result);
        dialog.setOnCancelListener(ignored -> { declined = true; result.complete(AllowOrDeny.DENY); });
        dialog.setOnDismissListener(ignored -> prompts.remove(dialog));
        dialog.show();
        return result;
    }

    private final class Prompts implements WebExtensionController.PromptDelegate {
        @Override public GeckoResult<WebExtension.PermissionPromptResponse> onInstallPromptRequest(WebExtension extension, String[] permissions, String[] origins, String[] data) {
            if (GeckoEngine.bundled(extension.id)) return GeckoResult.fromValue(new WebExtension.PermissionPromptResponse(false, false, false));
            return prompt(extension, "Install", permissions, origins, data).map(answer -> new WebExtension.PermissionPromptResponse(answer == AllowOrDeny.ALLOW, false, false));
        }
        @Override public GeckoResult<AllowOrDeny> onUpdatePrompt(WebExtension extension, String[] permissions, String[] origins, String[] data) {
            return prompt(extension, "Update", permissions, origins, data);
        }
        @Override public GeckoResult<AllowOrDeny> onOptionalPrompt(WebExtension extension, String[] permissions, String[] origins, String[] data) {
            return prompt(extension, "Additional access for", permissions, origins, data);
        }
    }

    void destroy() {
        disposed = true;
        if (operation != null) fail(operation, new IllegalStateException("Browser host closed"));
        for (Map.Entry<AlertDialog, GeckoResult<AllowOrDeny>> entry : new ArrayList<>(prompts.entrySet())) {
            entry.getValue().complete(AllowOrDeny.DENY);
            entry.getKey().dismiss();
        }
        pages.destroy();
        downloads.shutdownNow();
        engine.runtime.getWebExtensionController().setPromptDelegate(null);
        for (WebExtension extension : extensions.values()) {
            extension.setTabDelegate(null);
            extension.setActionDelegate(null);
            if (GeckoEngine.BRIDGE_ID.equals(extension.id)) extension.setMessageDelegate(null, "once_surface");
        }
        tabActions.clear();
    }
}
