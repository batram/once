package com.zmarn.once;

import android.app.Activity;
import android.app.AlertDialog;
import android.net.Uri;
import android.webkit.CookieManager;
import android.webkit.WebStorage;
import android.webkit.WebView;
import android.webkit.WebViewDatabase;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import com.zmarn.once.devtools.DevToolsClient;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.json.JSONObject;

/**
 * Clears what websites stored in the WebView profile every tab shares. The
 * public API clears cookies by name and DOM storage by origin; what it cannot
 * reach for one site (caches, IndexedDB, service workers) goes through
 * DevTools' Storage.clearDataForOrigin while the client is connected.
 */
final class LiteBrowsingData {
    private LiteBrowsingData() {}

    /** Asks first; resolves `{ cleared }`. Runs on the UI thread. */
    static void clearSite(Activity activity, PluginCall call) {
        String site = call.getString("site", "");
        if (site == null || site.isEmpty() || site.contains("/")) {
            call.reject("A site is required");
            return;
        }
        AlertDialog dialog = new AlertDialog.Builder(activity)
            .setTitle("Clear data for " + site + "?")
            .setMessage("Cookies, cache and stored data for this site and its subdomains are removed. You will be signed out of it.")
            .setNegativeButton("Cancel", (ignored, index) -> call.resolve(new JSObject().put("cleared", false)))
            .setPositiveButton("Clear", (ignored, index) -> clear(site, () -> call.resolve(new JSObject().put("cleared", true))))
            .create();
        dialog.setOnCancelListener(ignored -> call.resolve(new JSObject().put("cleared", false)));
        dialog.show();
    }

    private static void clear(String site, Runnable done) {
        CookieManager cookies = CookieManager.getInstance();
        for (String url : new String[] { "https://" + site + "/", "http://" + site + "/", "https://www." + site + "/" }) {
            String header = cookies.getCookie(url);
            if (header == null) continue;
            for (String pair : header.split(";")) {
                String name = pair.trim().split("=", 2)[0];
                if (name.isEmpty()) continue;
                // Expire every placement the cookie may have: the host, and the domain with and without a dot.
                cookies.setCookie(url, name + "=; Max-Age=0; Path=/");
                cookies.setCookie(url, name + "=; Max-Age=0; Path=/; Domain=" + site);
                cookies.setCookie(url, name + "=; Max-Age=0; Path=/; Domain=." + site);
            }
        }
        cookies.flush();
        WebStorage storage = WebStorage.getInstance();
        storage.getOrigins(origins -> {
            List<String> matching = new ArrayList<>();
            if (origins != null) for (Object origin : ((Map<?, ?>) origins).keySet()) {
                String host = Uri.parse(String.valueOf(origin)).getHost();
                if (host != null && (host.equalsIgnoreCase(site) || host.toLowerCase(java.util.Locale.ROOT).endsWith("." + site.toLowerCase(java.util.Locale.ROOT)))) {
                    matching.add(String.valueOf(origin));
                }
            }
            for (String origin : matching) storage.deleteOrigin(origin);
            DevToolsClient devtools = DevToolsClient.current();
            if (devtools != null) {
                for (String origin : matching) {
                    try {
                        devtools.send(null, "Storage.clearDataForOrigin", new JSONObject().put("origin", origin).put("storageTypes", "all"));
                    } catch (Exception ignored) { /* best effort beyond what the public API clears */ }
                }
            }
            done.run();
        });
    }

    /** The shell already asked. Runs on the UI thread. */
    static void clearAll(Activity activity, List<WebView> views, PluginCall call) {
        WebStorage.getInstance().deleteAllData();
        WebViewDatabase.getInstance(activity).clearHttpAuthUsernamePassword();
        for (WebView view : views) view.clearCache(true);
        CookieManager.getInstance().removeAllCookies(ignored -> {
            CookieManager.getInstance().flush();
            call.resolve(new JSObject());
        });
    }
}
