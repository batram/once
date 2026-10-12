package com.zmarn.once;

import android.app.Activity;
import android.view.View;
import android.widget.FrameLayout;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.util.function.Consumer;
import java.util.function.Supplier;
import org.json.JSONObject;

/**
 * A tab's out-of-page image text overlay (prototype; see ImageTextOverlay):
 * opened and given its words by the shell (mobileImageText.ts), placed by the
 * page's probe through the bridge port, closed when the page goes away.
 */
final class ImageTextOverlays {
    private final Supplier<Activity> activity;
    private final Supplier<FrameLayout> container;
    /** The visible page view, or null. */
    private final Supplier<View> page;
    private final Consumer<String> evaluate;
    private ImageTextOverlay current;

    ImageTextOverlays(Supplier<Activity> activity, Supplier<FrameLayout> container, Supplier<View> page, Consumer<String> evaluate) {
        this.activity = activity;
        this.container = container;
        this.page = page;
        this.evaluate = evaluate;
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

    /** Takes the bridge port's probe reports; false for any other message. */
    boolean receive(JSONObject message) {
        if (!"image-text-probe".equals(message.optString("type"))) return false;
        if (current != null) current.push(message.optString("payload"));
        return true;
    }

    /** The page went away (navigated, closed) with the image under the overlay. */
    void close() {
        if (current != null) current.close();
    }
}
