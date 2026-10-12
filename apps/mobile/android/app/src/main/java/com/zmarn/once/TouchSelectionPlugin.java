package com.zmarn.once;

import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.InputDevice;
import android.view.MotionEvent;
import android.view.ViewConfiguration;
import android.webkit.WebView;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The shell's WebView (Chromium) selects a word only on a long press; a
 * double tap there is a zoom gesture, off in this shell, so it does nothing.
 * Pages in GeckoView select on a double tap. Where the shell wants the same,
 * it asks for a long press at the tapped point: Chromium then starts its own
 * selection, with handles and the copy menu, which a scripted selection never
 * gets.
 */
@CapacitorPlugin(name = "TouchSelection")
public class TouchSelectionPlugin extends Plugin {
    private final Handler handler = new Handler(Looper.getMainLooper());
    private long pressDownTime;
    private float pressX, pressY;
    private Runnable release;
    private boolean hapticWas = true;

    /** x and y in the WebView's own pixels, from the page's CSS pixels times devicePixelRatio. */
    @PluginMethod
    public void longPressAt(PluginCall call) {
        Double x = call.getDouble("x");
        Double y = call.getDouble("y");
        if (x == null || y == null) { call.reject("x and y are required"); return; }
        getActivity().runOnUiThread(() -> {
            WebView view = getBridge().getWebView();
            realTouchStarted();
            pressDownTime = SystemClock.uptimeMillis();
            pressX = x.floatValue();
            pressY = y.floatValue();
            // The user double tapped; the long press is ours, so it must not buzz like one.
            hapticWas = view.isHapticFeedbackEnabled();
            view.setHapticFeedbackEnabled(false);
            send(view, MotionEvent.ACTION_DOWN);
            release = () -> { release = null; send(view, MotionEvent.ACTION_UP); view.setHapticFeedbackEnabled(hapticWas); };
            // Held just past the timeout, so Chromium sees a long press, not a tap.
            handler.postDelayed(release, ViewConfiguration.getLongPressTimeout() + 30);
            call.resolve();
        });
    }

    /**
     * A touch while the press is held, real or the next requested one, ends it
     * first: two touch streams at once confuse Chromium's gesture detector.
     */
    void realTouchStarted() {
        if (release == null) return;
        handler.removeCallbacks(release);
        release = null;
        WebView view = getBridge().getWebView();
        send(view, MotionEvent.ACTION_CANCEL);
        view.setHapticFeedbackEnabled(hapticWas);
    }

    private void send(WebView view, int action) {
        MotionEvent.PointerProperties properties = new MotionEvent.PointerProperties();
        properties.id = 0;
        properties.toolType = MotionEvent.TOOL_TYPE_FINGER;
        MotionEvent.PointerCoords coords = new MotionEvent.PointerCoords();
        coords.x = pressX;
        coords.y = pressY;
        coords.pressure = 1f;
        coords.size = 1f;
        MotionEvent event = MotionEvent.obtain(pressDownTime, SystemClock.uptimeMillis(), action, 1,
            new MotionEvent.PointerProperties[] { properties }, new MotionEvent.PointerCoords[] { coords },
            0, 0, 1f, 1f, 0, 0, InputDevice.SOURCE_TOUCHSCREEN, 0);
        view.dispatchTouchEvent(event);
        event.recycle();
    }
}
