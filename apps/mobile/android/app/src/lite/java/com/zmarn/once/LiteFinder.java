package com.zmarn.once;

import android.webkit.WebView;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;

/**
 * One find step through the WebView's finder: a changed query counts its
 * matches afresh and lands on the first, the same query moves on. Wrapping is
 * read off the index change, which the view does not report itself.
 */
final class LiteFinder {
    private WebView attached;
    private String query = "";
    private int ordinal = -1;
    private PluginCall pending;
    private boolean forward = true;
    private boolean fresh;

    void find(PluginCall call, WebView view) {
        String wanted = call.getString("query");
        if (wanted == null || wanted.isEmpty()) { call.reject("Search text is required"); return; }
        if (view == null) { call.reject("There is no open page"); return; }
        if (pending != null) pending.reject("Superseded by a newer search");
        if (attached != view) {
            attached = view;
            query = "";
            view.setFindListener((active, total, done) -> { if (done) settle(active, total); });
        }
        pending = call;
        forward = call.getBoolean("forward", true);
        fresh = !wanted.equals(query);
        if (fresh) { query = wanted; ordinal = -1; view.findAllAsync(wanted); }
        else view.findNext(forward);
    }

    private void settle(int active, int total) {
        PluginCall call = pending;
        pending = null;
        boolean wrapped = !fresh && total > 1 && ordinal >= 0 && (forward ? active < ordinal : active > ordinal);
        ordinal = active;
        if (call == null) return;
        JSObject payload = new JSObject();
        payload.put("found", total > 0);
        payload.put("wrapped", wrapped);
        payload.put("current", total > 0 ? active + 1 : 0);
        payload.put("total", total);
        call.resolve(payload);
    }

    void clear(WebView view) {
        if (pending != null) { pending.reject("The search was cleared"); pending = null; }
        query = "";
        ordinal = -1;
        if (view != null) view.clearMatches();
    }
}
