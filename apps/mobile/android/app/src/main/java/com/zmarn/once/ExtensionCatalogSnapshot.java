package com.zmarn.once;

import android.content.Context;
import android.content.SharedPreferences;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The extension catalog as the shell last received it, kept across launches so
 * Settings lists extensions without starting the browsing engine. The engine's
 * own change event replaces the snapshot with the live catalog once it runs.
 */
public final class ExtensionCatalogSnapshot {
    private static final String PREFERENCES = "once_extension_catalog";
    private final SharedPreferences preferences;
    private final String key;

    /** One snapshot per engine, since Gecko and Lite host different extensions. */
    public ExtensionCatalogSnapshot(Context context, String engine) {
        preferences = context.getApplicationContext().getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
        key = engine;
    }

    public void save(JSONArray extensions) {
        String encoded = encode(extensions);
        if (encoded != null) preferences.edit().putString(key, encoded).apply();
    }

    /** The saved catalog; null when none was saved yet or it is unreadable. */
    public JSONArray load() { return decode(preferences.getString(key, null)); }

    /**
     * Answers a plain `list` from the saved catalog while the engine is not ready,
     * so the shell never starts an engine just to draw rows. A refresh, any other
     * command, a ready engine or nothing saved yet leave the call to the engine.
     */
    public static boolean answer(PluginCall call, Context context, String engine, boolean engineReady) {
        if (engineReady || !"list".equals(call.getString("action", "list")) || Boolean.TRUE.equals(call.getBoolean("refresh", false))) return false;
        JSONArray saved = new ExtensionCatalogSnapshot(context, engine).load();
        if (saved == null) return false;
        call.resolve(response(saved));
        return true;
    }

    /** What the shell receives in place of a live catalog. */
    public static JSObject response(JSONArray extensions) {
        JSObject result = new JSObject();
        result.put("extensions", extensions);
        result.put("snapshot", true);
        return result;
    }

    /** The text to store, or null for a catalog that would not load again. */
    static String encode(JSONArray extensions) {
        String text = extensions.toString();
        return text != null && decode(text) != null ? text : null;
    }

    /** Only a list of rows carrying the identity the shell draws counts as a snapshot. */
    static JSONArray decode(String text) {
        if (text == null) return null;
        try {
            JSONArray extensions = new JSONArray(text);
            for (int i = 0; i < extensions.length(); i++) {
                JSONObject row = extensions.optJSONObject(i);
                if (row == null || !(row.opt("id") instanceof String) || !(row.opt("name") instanceof String)) return null;
            }
            return extensions;
        } catch (JSONException error) {
            return null;
        }
    }
}
