package com.zmarn.once;

import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import org.mozilla.geckoview.GeckoSession;
import org.mozilla.geckoview.SessionFinder;

/** Runs one find operation against the owning tab's captured session. */
final class ReadingPageFinder {
    static void find(PluginCall call, GeckoSession session) {
        String query = call.getString("query");
        if (query == null || query.isEmpty()) { call.reject("Search text is required"); return; }
        if (session == null) { call.reject("There is no open page"); return; }
        SessionFinder finder = session.getFinder();
        finder.setDisplayFlags(GeckoSession.FINDER_DISPLAY_HIGHLIGHT_ALL);
        int flags = call.getBoolean("forward", true) ? 0 : GeckoSession.FINDER_FIND_BACKWARDS;
        finder.find(query, flags).accept(result -> {
            JSObject payload = new JSObject();
            payload.put("found", result != null && result.found);
            payload.put("wrapped", result != null && result.wrapped);
            payload.put("current", result == null ? 0 : result.current);
            payload.put("total", result == null ? 0 : result.total);
            call.resolve(payload);
        }, error -> call.reject("The page could not be searched: " + error));
    }
}
