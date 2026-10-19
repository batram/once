package com.zmarn.once;

import android.net.Uri;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.util.function.Consumer;

/**
 * Extension pages (popups, options) in dedicated WebViews: M2 of
 * docs/plans/once-lite-plan.md. Until then nothing is open, which the shell's
 * frame hears once, and its commands are accepted and ignored.
 */
final class LiteExtensionPages {
    /** Extension pages live at https://<host>.moz-extension.localhost/; the browser.* shim keeps the moz-extension form. */
    static final String PAGE_HOST_SUFFIX = ".moz-extension.localhost";
    private final Consumer<JSObject> state;

    LiteExtensionPages(Consumer<JSObject> state) {
        this.state = state;
        publish();
    }

    static boolean isExtensionUrl(String url) {
        if (url == null) return false;
        Uri uri = Uri.parse(url);
        if ("moz-extension".equalsIgnoreCase(uri.getScheme())) return true;
        String host = uri.getHost();
        return "https".equalsIgnoreCase(uri.getScheme()) && host != null && host.toLowerCase(java.util.Locale.ROOT).endsWith(PAGE_HOST_SUFFIX);
    }

    /** The shell's `extensionPage {action: close|reload|bounds}`; nothing is open yet. */
    void handleCommand(PluginCall call) { call.resolve(); }

    boolean hasPopup() { return false; }
    void closeVisible() {}
    void setResumed(boolean value) {}
    void trimHidden() {}

    private void publish() {
        state.accept(new JSObject().put("open", false).put("popup", false).put("title", "").put("status", "").put("count", 0));
    }
}
