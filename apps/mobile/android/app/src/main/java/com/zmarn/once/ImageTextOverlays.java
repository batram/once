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
    /** Runs a script in the page's bridge content script, without an answer. */
    private final Consumer<String> evaluate;
    /** Runs a script there and hands its JSON-encoded value (null when it failed) back. */
    private final BiConsumer<String, Consumer<String>> request;
    private ImageTextOverlay current;
    private ImageTextBar bar;
    private String barToken;

    ImageTextOverlays(Supplier<Activity> activity, Supplier<FrameLayout> container, Supplier<View> page,
                      Consumer<String> evaluate, BiConsumer<String, Consumer<String>> request) {
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
        if ("open".equals(action)) {
            JSObject fit = call.getObject("fit", null);
            View view = page.get();
            if (view == null || container.get() == null || fit == null) { call.reject("There is no page to select in"); return; }
            close();
            current = new ImageTextOverlay(activity.get(), container.get(), view, token, fit, new ImageTextOverlay.Host() {
                @Override public void evaluate(String code) { ImageTextOverlays.this.evaluate.accept(code); }
                @Override public void closed(ImageTextOverlay overlay) { if (current == overlay) current = null; }
            });
        } else if ("result".equals(action) && current != null && current.token.equals(token)) {
            current.result(call.getObject("result", null), call.getString("message", ""));
        }
        call.resolve();
    }

    /** Takes the bridge port's image text reports: `{ token, bar }` or `{ token, fit }`. False for other messages. */
    boolean receive(JSONObject message) {
        if (!"image-text".equals(message.optString("type"))) return false;
        String payload = message.optString("payload");
        JSONObject report;
        try { report = new JSONObject(payload); } catch (Exception error) { return true; }
        if (report.has("bar")) showBar(report.optString("token"), report.optJSONObject("bar"));
        else if (current != null) current.push(payload);
        return true;
    }

    /** The page went away (navigated, closed) with the selection in it. */
    void close() {
        if (current != null) current.close();
        removeBar();
    }

    private void showBar(String token, JSONObject state) {
        if (state == null) {
            if (token.equals(barToken)) removeBar();
            return;
        }
        if (bar == null || !token.equals(barToken)) {
            removeBar();
            FrameLayout parent = container.get();
            if (parent == null || activity.get() == null) return;
            barToken = token;
            bar = new ImageTextBar(activity.get(), parent, true, () -> copy(token), () -> done(token));
        }
        bar.show(state.optString("status"), state.optBoolean("copy"));
    }

    /** Copies what the page's selection holds, as the page's own Copy did. */
    private void copy(String token) {
        String session = "(() => { const s = window.__onceImageText; return s?.token === " + JSONObject.quote(token) + " ? s.copyText() : \"\" })()";
        request.accept(session, value -> {
            if (bar == null || !token.equals(barToken)) return;
            String text = "";
            try { if (value != null) text = String.valueOf(new JSONTokener(value).nextValue()); } catch (Exception ignored) { text = ""; }
            ClipboardManager clipboard = (ClipboardManager) activity.get().getSystemService(Context.CLIPBOARD_SERVICE);
            if (text.isEmpty() || clipboard == null) { bar.feedback("Couldn’t copy the text"); return; }
            clipboard.setPrimaryClip(ClipData.newPlainText("Image text", text));
            bar.feedback("Copied");
        });
    }

    private void done(String token) {
        removeBar();
        evaluate.accept("window.__onceImageText?.token === " + JSONObject.quote(token) + " && window.__onceImageText.close()");
    }

    private void removeBar() {
        if (bar != null) bar.remove();
        bar = null;
        barToken = null;
    }
}
