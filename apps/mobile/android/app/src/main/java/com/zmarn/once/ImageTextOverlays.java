package com.zmarn.once;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.view.View;
import android.widget.FrameLayout;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.util.function.BiConsumer;
import java.util.function.Consumer;
import java.util.function.Supplier;
import org.json.JSONObject;
import org.json.JSONTokener;
import org.mozilla.geckoview.WebExtension;

/**
 * A tab's image text selection, as far as the app shows it natively: the bar
 * of the in-page selection (see imageTextInjection.ts), which reports what it
 * shows through the bridge port, and the out-of-page overlay prototype (see
 * ImageTextOverlay), opened and given its words by the shell
 * (mobileImageText.ts) and placed by the page's probe. Both end when the page
 * goes away.
 */
final class ImageTextOverlays {
    private final Supplier<Activity> activity;
    private final Supplier<FrameLayout> container;
    /** The visible page view, or null. */
    private final Supplier<View> page;
    /** The current page's bridge port, for the prototype's overlay. */
    private final Supplier<WebExtension.Port> port;
    /** Runs a script in a page's bridge content script, through its port, without an answer. */
    private final BiConsumer<String, WebExtension.Port> evaluate;
    /** Runs a script there and hands its JSON-encoded value (null when it failed) back. */
    private final ScriptRequest request;
    /** A double-tapped image in the current page, `{ image, referrer }`: the shell selects its text. */
    private final Consumer<JSONObject> requested;
    private ImageTextOverlay current;
    private ImageTextBar bar;
    private String barToken;
    /** The port of the page whose selection the bar belongs to: the bar talks to that page alone. */
    private WebExtension.Port barPort;
    private final androidx.activity.OnBackPressedCallback back = new androidx.activity.OnBackPressedCallback(false) {
        @Override public void handleOnBackPressed() { if (barToken != null) done(barToken); }
    };

    interface ScriptRequest { void run(String script, WebExtension.Port port, Consumer<String> answer); }

    ImageTextOverlays(Supplier<Activity> activity, Supplier<FrameLayout> container, Supplier<View> page,
                      Supplier<WebExtension.Port> port, BiConsumer<String, WebExtension.Port> evaluate, ScriptRequest request,
                      Consumer<JSONObject> requested) {
        this.port = port;
        this.requested = requested;
        this.activity = activity;
        this.container = container;
        this.page = page;
        this.evaluate = evaluate;
        this.request = request;
    }

    /** The shell's `{ action: "open", token, fit }` or `{ action: "result", token, result, message }`; on the UI thread. */
    void command(PluginCall call) {
        String token = call.getString("token", "");
        String action = call.getString("action", "");
        if ("missing".equals(action) && activity.get() != null) {
            android.widget.Toast.makeText(activity.get(), "Couldn’t select text in this image", android.widget.Toast.LENGTH_SHORT).show();
        } else if ("open".equals(action)) {
            JSObject fit = call.getObject("fit", null);
            View view = page.get();
            if (view == null || container.get() == null || fit == null) { call.reject("There is no page to select in"); return; }
            close();
            WebExtension.Port port = this.port.get();
            current = new ImageTextOverlay(activity.get(), container.get(), view, token, fit, new ImageTextOverlay.Host() {
                @Override public void evaluate(String code) { ImageTextOverlays.this.evaluate.accept(code, port); }
                @Override public void closed(ImageTextOverlay overlay) { if (current == overlay) current = null; }
            });
        } else if ("result".equals(action) && current != null && current.token.equals(token)) {
            current.result(call.getObject("result", null), call.getString("message", ""));
        }
        call.resolve();
    }

    /**
     * Takes a page port's image text reports: `{ token, bar }` or `{ token, fit }`, and
     * double-tapped images (content.js), from the current page only. False for other messages.
     */
    boolean receive(JSONObject message, WebExtension.Port from) {
        if ("image-text-request".equals(message.optString("type"))) {
            if (from == port.get() && !message.optString("image").isEmpty()) requested.accept(message);
            return true;
        }
        if (!"image-text".equals(message.optString("type"))) return false;
        String payload = message.optString("payload");
        JSONObject report;
        try { report = new JSONObject(payload); } catch (Exception error) { return true; }
        if (report.has("bar")) showBar(report.optString("token"), report.optJSONObject("bar"), from);
        else if (current != null) current.push(payload);
        return true;
    }

    /** A page's port went away: so did that page's selection. */
    void closed(WebExtension.Port port) {
        if (port == barPort) removeBar();
        if (current != null && port == this.port.get()) current.close();
    }

    /** The page went away (navigated, closed, rebuilt) with the selection in it. */
    void close() {
        if (current != null) current.close();
        removeBar();
    }

    private void showBar(String token, JSONObject state, WebExtension.Port from) {
        if (state == null) {
            if (token.equals(barToken)) removeBar();
            return;
        }
        if (bar == null || !token.equals(barToken)) {
            removeBar();
            FrameLayout parent = container.get();
            Activity owner = activity.get();
            if (parent == null || !(owner instanceof androidx.activity.ComponentActivity)) return;
            barToken = token;
            bar = new ImageTextBar(owner, parent, true, () -> copy(token), () -> done(token));
            // Back closes the selection first, as it does a platform text selection.
            ((androidx.activity.ComponentActivity) owner).getOnBackPressedDispatcher().addCallback(back);
            back.setEnabled(true);
        }
        barPort = from;
        bar.show(state.optString("status"), state.optBoolean("copy"));
    }

    /** Copies what the page's selection holds, as the page's own Copy did. */
    private void copy(String token) {
        String session = "(() => { const s = window.__onceImageText; return s?.token === " + JSONObject.quote(token) + " ? s.copyText() : \"\" })()";
        request.run(session, barPort, value -> {
            if (bar == null || !token.equals(barToken)) return;
            String text = "";
            try {
                Object decoded = value == null ? null : new JSONTokener(value).nextValue();
                if (decoded instanceof String) text = (String) decoded;
            } catch (Exception ignored) { text = ""; }
            ClipboardManager clipboard = (ClipboardManager) activity.get().getSystemService(Context.CLIPBOARD_SERVICE);
            if (text.isEmpty() || clipboard == null) { bar.feedback("Couldn’t copy the text"); return; }
            clipboard.setPrimaryClip(ClipData.newPlainText("Image text", text));
            bar.feedback("Copied");
        });
    }

    private void done(String token) {
        WebExtension.Port port = barPort;
        removeBar();
        evaluate.accept("window.__onceImageText?.token === " + JSONObject.quote(token) + " && window.__onceImageText.close()", port);
    }

    private void removeBar() {
        if (bar != null) bar.remove();
        bar = null;
        barToken = null;
        barPort = null;
        back.setEnabled(false);
        back.remove();
    }
}
