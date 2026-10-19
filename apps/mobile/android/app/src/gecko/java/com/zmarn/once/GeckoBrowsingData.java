package com.zmarn.once;

import android.app.Activity;
import android.app.AlertDialog;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import org.mozilla.geckoview.GeckoResult;
import org.mozilla.geckoview.StorageController;

/**
 * Clears what websites stored in GeckoView's profile. The Capacitor shell is a
 * system WebView with its own storage, so Once's database is out of reach here.
 * Clearing everything leaves the moz-extension stores of the built-in
 * extensions (uBlock Origin's lists, Violentmonkey's scripts) where they are:
 * on GeckoView 155 their storage/default directories kept all their data
 * through clearData(FLAGS) while every web origin's went.
 */
final class GeckoBrowsingData {
    /**
     * Everything a site can leave behind: cookies, caches, DOM storages,
     * permissions and site settings (SITE_DATA), plus HTTP auth sessions.
     * Not ALL, a separate bit that reaches past site data into the profile.
     */
    private static final long FLAGS = StorageController.ClearFlags.SITE_DATA | StorageController.ClearFlags.AUTH_SESSIONS;

    private GeckoBrowsingData() {}

    /** Asks first; resolves `{ cleared }`. Runs on the UI thread. */
    static void clearSite(Activity activity, GeckoEngine engine, PluginCall call) {
        String site = call.getString("site", "");
        if (site == null || site.isEmpty() || site.contains("/")) {
            call.reject("A site is required");
            return;
        }
        AlertDialog dialog = new AlertDialog.Builder(activity)
            .setTitle("Clear data for " + site + "?")
            .setMessage("Cookies, cache and stored data for this site and its subdomains are removed. You will be signed out of it.")
            .setNegativeButton("Cancel", (ignored, index) -> call.resolve(new JSObject().put("cleared", false)))
            .setPositiveButton("Clear", (ignored, index) -> settle(
                engine.runtime.getStorageController().clearDataFromBaseDomain(site, FLAGS),
                call, new JSObject().put("cleared", true)))
            .create();
        dialog.setOnCancelListener(ignored -> call.resolve(new JSObject().put("cleared", false)));
        dialog.show();
    }

    /** The shell already asked. Runs on the UI thread. */
    static void clearAll(GeckoEngine engine, PluginCall call) {
        settle(engine.runtime.getStorageController().clearData(FLAGS), call, new JSObject());
    }

    private static void settle(GeckoResult<Void> result, PluginCall call, JSObject value) {
        result.accept(ignored -> call.resolve(value), error -> call.reject("Could not clear browsing data", error instanceof Exception ? (Exception) error : null));
    }
}
