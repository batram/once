package com.zmarn.once;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONObject;

/**
 * Image text selection out of the page (prototype): a transparent system
 * WebView laid over the long-pressed image, holding the recognized words for
 * the platform's own touch selection, and a native bar beside it. Nothing of
 * it enters the page. A read-only probe in the page's bridge content script
 * pushes where the image is (see imageTextProbe.ts), and the views follow.
 *
 * Touches on the words view stay there for selecting (long press, taps); a
 * pan or pinch that starts on it is handed to the page underneath, so the page
 * still scrolls and zooms from the image.
 */
final class ImageTextOverlay {
    interface Host {
        /** Runs a script in the page's bridge content script, without an answer. */
        void evaluate(String code);
        void closed(ImageTextOverlay overlay);
    }

    private static final String TAG = "OnceImageText";
    private static final int GAP_DP = 8;
    private static String script;

    final String token;
    private final Activity activity;
    private final FrameLayout container;
    private final View page;
    private final Host host;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final WordsView words;
    private final LinearLayout bar;
    private final TextView status;
    private final Button copy;
    private final float density;
    private final List<String> pending = new ArrayList<>();
    private JSONObject fit;
    private String lastLayout = "";
    private boolean ready;
    private boolean closed;
    private final boolean pageTakesFocus;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    ImageTextOverlay(Activity activity, FrameLayout container, View page, String token, JSONObject fit, Host host) {
        this.activity = activity;
        this.container = container;
        this.page = page;
        this.token = token;
        this.host = host;
        this.fit = fit;
        density = activity.getResources().getDisplayMetrics().density;
        // A view losing focus drops its selection: while selecting, touches on
        // the page (scrolling it) must not take focus from the words.
        pageTakesFocus = page.isFocusableInTouchMode();
        page.setFocusableInTouchMode(false);

        words = new WordsView(activity, page);
        words.setBackgroundColor(Color.TRANSPARENT);
        WebSettings settings = words.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setSupportZoom(false);
        settings.setTextZoom(100);
        words.setVerticalScrollBarEnabled(false);
        words.setHorizontalScrollBarEnabled(false);
        words.setOverScrollMode(View.OVER_SCROLL_NEVER);
        // Only the app's own page, inlined below, ever loads here.
        words.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) { return true; }
        });
        words.addJavascriptInterface(new Bridge(), "onceImageTextNative");
        String html = "<!doctype html><meta charset=utf-8>"
            + "<meta name=viewport content=\"width=device-width,initial-scale=1\">"
            + "<style>html,body{margin:0;background:transparent}</style><body><script>"
            + script(activity).replace("</script", "<\\/script") + "</script>";
        words.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
        container.addView(words, new FrameLayout.LayoutParams(1, 1));
        // The page's views went away (the tab closed or was rebuilt): so does the overlay.
        words.addOnAttachStateChangeListener(new View.OnAttachStateChangeListener() {
            @Override public void onViewAttachedToWindow(View view) { }
            @Override public void onViewDetachedFromWindow(View view) { close(); }
        });

        boolean dark = (activity.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        bar = new LinearLayout(activity);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        GradientDrawable background = new GradientDrawable();
        background.setColor(dark ? Color.rgb(37, 41, 48) : Color.WHITE);
        background.setCornerRadius(12 * density);
        background.setStroke(Math.round(density), dark ? Color.rgb(111, 119, 131) : Color.rgb(184, 190, 199));
        bar.setBackground(background);
        bar.setElevation(6 * density);
        int padding = Math.round(10 * density);
        bar.setPadding(padding + padding / 2, padding / 3, padding / 3, padding / 3);
        status = new TextView(activity);
        status.setText("Recognizing text…");
        status.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        status.setTextColor(dark ? Color.rgb(241, 243, 246) : Color.rgb(32, 36, 43));
        bar.addView(status);
        copy = new Button(activity, null, android.R.attr.borderlessButtonStyle);
        copy.setText("Copy");
        copy.setVisibility(View.GONE);
        copy.setOnClickListener(ignored -> copyText());
        bar.addView(copy);
        Button done = new Button(activity, null, android.R.attr.borderlessButtonStyle);
        done.setText("Done");
        done.setOnClickListener(ignored -> close());
        bar.addView(done);
        bar.setVisibility(View.INVISIBLE);
        container.addView(bar, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        // Placed once it has measured itself.
        bar.addOnLayoutChangeListener((view, l, t, r, b, ol, ot, or, ob) -> { if (r - l != or - ol || b - t != ob - ot) place(); });
        place();
    }

    /** A probe report: `{ token, fit }`, the fit null once the image is gone. */
    void push(String payload) {
        if (closed) return;
        try {
            JSONObject report = new JSONObject(payload);
            if (!token.equals(report.optString("token"))) return;
            JSONObject next = report.optJSONObject("fit");
            if (next == null) { close(); return; }
            fit = next;
            place();
        } catch (Exception error) {
            Log.w(TAG, "Unreadable probe report", error);
        }
    }

    /** The recognized words, or null with a message when there are none. */
    void result(JSONObject result, String message) {
        try {
            JSONObject command = new JSONObject();
            command.put("type", "result");
            command.put("result", result == null ? JSONObject.NULL : result);
            if (message != null && !message.isEmpty()) command.put("message", message);
            send(command.toString());
        } catch (Exception error) {
            Log.w(TAG, "Could not pass the recognized text", error);
        }
    }

    void close() {
        if (closed) return;
        closed = true;
        handler.removeCallbacksAndMessages(null);
        container.removeView(words);
        container.removeView(bar);
        words.destroy();
        page.setFocusableInTouchMode(pageTakesFocus);
        host.evaluate("window.__onceImageTextProbe?.stop(" + JSONObject.quote(token) + ")");
        host.closed(this);
    }

    /**
     * Lays the views over the image: CSS pixels of the page's layout viewport
     * to the page view's device pixels, through its pinch zoom.
     */
    private void place() {
        if (closed || fit == null) return;
        double visualLeft = fit.optDouble("visualLeft", 0), visualTop = fit.optDouble("visualTop", 0);
        double scale = fit.optDouble("visualScale", 1) * fit.optDouble("pixelRatio", 1);
        JSONObject box = fit.optJSONObject("visibleBox");
        int width = page.getWidth(), height = page.getHeight();
        int left = 0, top = 0, right = 0, bottom = 0;
        if (box != null) {
            left = clamp((int) Math.floor((box.optDouble("left") - visualLeft) * scale), 0, width);
            top = clamp((int) Math.floor((box.optDouble("top") - visualTop) * scale), 0, height);
            right = clamp((int) Math.ceil((box.optDouble("right") - visualLeft) * scale), 0, width);
            bottom = clamp((int) Math.ceil((box.optDouble("bottom") - visualTop) * scale), 0, height);
        }
        if (!fit.optBoolean("visible") || right <= left || bottom <= top) {
            words.setVisibility(View.INVISIBLE);
            bar.setVisibility(View.INVISIBLE);
            return;
        }
        ViewGroup.LayoutParams params = words.getLayoutParams();
        if (params.width != right - left || params.height != bottom - top) {
            params.width = right - left;
            params.height = bottom - top;
            words.setLayoutParams(params);
        }
        words.setTranslationX(page.getX() + left);
        words.setTranslationY(page.getY() + top);
        words.setVisibility(View.VISIBLE);
        try {
            // The drawn picture in the words view's CSS pixels.
            double pictureLeft = (fit.optDouble("left") + fit.optDouble("imageLeft") - visualLeft) * scale;
            double pictureTop = (fit.optDouble("top") + fit.optDouble("imageTop") - visualTop) * scale;
            JSONObject layout = new JSONObject()
                .put("left", (pictureLeft - left) / density).put("top", (pictureTop - top) / density)
                .put("width", fit.optDouble("imageWidth") * scale / density).put("height", fit.optDouble("imageHeight") * scale / density)
                .put("naturalWidth", fit.optDouble("naturalWidth")).put("naturalHeight", fit.optDouble("naturalHeight"))
                .put("pageTop", -top / density).put("pageBottom", (height - top) / density)
                .put("viewLeft", left / density).put("viewTop", top / density);
            String key = layout.toString();
            if (!key.equals(lastLayout)) {
                lastLayout = key;
                send(new JSONObject().put("type", "layout").put("layout", layout).toString());
            }
        } catch (Exception error) {
            Log.w(TAG, "Could not lay out the image text", error);
        }
        placeBar(left, top, right, bottom, width, height);
    }

    /** Below the image's visible part, else above it, else inside its bottom edge. */
    private void placeBar(int left, int top, int right, int bottom, int width, int height) {
        int w = bar.getWidth(), h = bar.getHeight();
        if (w == 0 || h == 0) { bar.setVisibility(View.INVISIBLE); return; }
        int gap = Math.round(GAP_DP * density);
        int x = clamp(right - w, gap, Math.max(gap, width - w - gap));
        int y = bottom + gap + h <= height - gap ? bottom + gap
            : top - gap - h >= gap ? top - gap - h
            : clamp(bottom - h - gap, gap, Math.max(gap, height - h - gap));
        bar.setTranslationX(page.getX() + x);
        bar.setTranslationY(page.getY() + y);
        bar.setVisibility(View.VISIBLE);
    }

    private void copyText() {
        words.evaluateJavascript("window.__onceImageTextCopy?.() ?? ''", value -> {
            String text;
            try { text = new org.json.JSONTokener(value).nextValue().toString(); } catch (Exception error) { text = ""; }
            if (text.isEmpty()) return;
            ClipboardManager clipboard = (ClipboardManager) activity.getSystemService(Context.CLIPBOARD_SERVICE);
            // Android 13+ confirms clipboard writes itself.
            if (clipboard != null) clipboard.setPrimaryClip(ClipData.newPlainText("Image text", text));
        });
    }

    private void send(String message) {
        if (closed) return;
        if (!ready) { pending.add(message); return; }
        words.evaluateJavascript("window.__onceImageTextMessage?.(" + JSONObject.quote(message) + ")", null);
    }

    private void received(String json) {
        if (closed) return;
        try {
            JSONObject event = new JSONObject(json);
            switch (event.optString("type")) {
                case "ready":
                    ready = true;
                    for (String message : pending) send(message);
                    pending.clear();
                    break;
                case "status":
                    status.setText(event.optString("text"));
                    copy.setVisibility(View.VISIBLE);
                    break;
                case "close":
                    close();
                    break;
                default:
                    break;
            }
        } catch (Exception error) {
            Log.w(TAG, "Unreadable overlay event", error);
        }
    }

    private final class Bridge {
        // Called on a WebView thread; the views live on the main thread.
        @JavascriptInterface
        public void send(String json) { handler.post(() -> received(json)); }
    }

    private static int clamp(int value, int min, int max) { return Math.max(min, Math.min(max, value)); }

    private static synchronized String script(Context context) {
        if (script != null) return script;
        try (InputStream input = context.getAssets().open("public/image-text-overlay.js");
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[16384];
            for (int read; (read = input.read(buffer)) > 0;) output.write(buffer, 0, read);
            script = output.toString(StandardCharsets.UTF_8.name());
        } catch (Exception error) {
            Log.w(TAG, "The image text overlay page is missing", error);
            script = "";
        }
        return script;
    }

    /**
     * The words view. A gesture that moves (or adds a finger) within the tap
     * timeout is a pan or pinch for the page, which gets it from its start;
     * the words view never sees it, so its selection stays. A gesture that
     * holds still (a long press) or lifts (a tap) is replayed to the words view.
     */
    private static final class WordsView extends WebView {
        private enum Owner { UNDECIDED, WORDS, PAGE }
        private final View page;
        private final int slop;
        private final List<MotionEvent> held = new ArrayList<>();
        private final Runnable decide = () -> give(Owner.WORDS);
        private Owner owner = Owner.WORDS;

        WordsView(Context context, View page) {
            super(context);
            this.page = page;
            slop = ViewConfiguration.get(context).getScaledTouchSlop();
        }

        @SuppressLint("ClickableViewAccessibility")
        @Override
        public boolean dispatchTouchEvent(MotionEvent event) {
            int action = event.getActionMasked();
            if (action == MotionEvent.ACTION_DOWN) {
                release();
                owner = Owner.UNDECIDED;
                held.add(MotionEvent.obtain(event));
                postDelayed(decide, ViewConfiguration.getTapTimeout());
                return true;
            }
            if (owner == Owner.PAGE) { forward(event); return true; }
            if (owner == Owner.WORDS) return super.dispatchTouchEvent(event);
            held.add(MotionEvent.obtain(event));
            MotionEvent down = held.get(0);
            boolean moved = action == MotionEvent.ACTION_MOVE
                && Math.hypot(event.getX() - down.getX(), event.getY() - down.getY()) > slop;
            if (moved || action == MotionEvent.ACTION_POINTER_DOWN) give(Owner.PAGE);
            else if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) give(Owner.WORDS);
            return true;
        }

        private void give(Owner next) {
            removeCallbacks(decide);
            if (owner != Owner.UNDECIDED) return;
            owner = next;
            for (MotionEvent event : held) {
                if (next == Owner.PAGE) forward(event);
                else super.dispatchTouchEvent(event);
            }
            release();
            owner = next;
        }

        private void release() {
            removeCallbacks(decide);
            for (MotionEvent event : held) event.recycle();
            held.clear();
        }

        private void forward(MotionEvent event) {
            MotionEvent moved = MotionEvent.obtain(event);
            moved.offsetLocation(getX() - page.getX(), getY() - page.getY());
            page.dispatchTouchEvent(moved);
            moved.recycle();
        }
    }
}
