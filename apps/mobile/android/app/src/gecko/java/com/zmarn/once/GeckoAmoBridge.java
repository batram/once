package com.zmarn.once;

import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.util.function.Supplier;
import org.json.JSONObject;
import org.mozilla.geckoview.GeckoResult;
import org.mozilla.geckoview.GeckoSession;
import org.mozilla.geckoview.WebExtension;

/** Adapts AMO's isolated content script to the same command/review path as Settings. */
final class GeckoAmoBridge implements WebExtension.MessageDelegate {
    private final GeckoExtensionManager manager;
    private final GeckoSession session;
    private final Supplier<String> location;

    GeckoAmoBridge(GeckoExtensionManager manager, GeckoSession session, Supplier<String> location) {
        this.manager = manager;
        this.session = session;
        this.location = location;
    }

    @Override public GeckoResult<Object> onMessage(String app, Object message, WebExtension.MessageSender sender) {
        String url = location.get();
        if (sender.session != session || !sender.isTopLevel() ||
            sender.environmentType != WebExtension.MessageSender.ENV_TYPE_CONTENT_SCRIPT ||
            !GeckoExtensionSource.isAmo(sender.url) || !GeckoExtensionSource.isListing(url) ||
            !(message instanceof JSONObject)) {
            return GeckoResult.fromException(new IllegalArgumentException("Only a Mozilla add-on listing can use this bridge"));
        }
        String action = ((JSONObject) message).optString("action");
        if (!"list".equals(action) && !"install".equals(action)) {
            return GeckoResult.fromException(new IllegalArgumentException("Unsupported add-on page action"));
        }
        GeckoResult<Object> result = new GeckoResult<>();
        // The URL comes from the native session, never from page-supplied data.
        // Reuse the manager's serialization, signature checks, permission review,
        // cancellation and catalog notifications rather than a second installer.
        manager.command(new PluginCall(null, "InAppBrowserSurface", "amo", "extensionCommand",
            new JSObject().put("action", action).put("source", url)) {
            // Gecko's one-shot callback accepts primitives/GeckoBundle, not
            // Capacitor's JSONObject. Encode both results and useful errors.
            @Override public void resolve(JSObject value) { result.complete(value.toString()); }
            @Override public void reject(String error) { result.complete(new JSObject().put("error", error).toString()); }
        });
        return result;
    }
}
