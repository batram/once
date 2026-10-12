package com.zmarn.once;

import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.InputDevice;
import android.view.MotionEvent;
import android.webkit.WebView;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The shell's WebView (Chromium) selects a word only on a long press: Blink
 * keeps a touch double tap's word selection to editable text (see
 * SelectionController::HandleMousePressEvent), and Chrome's own double-tap
 * selection is its Touch to Search, which WebView lacks. A selection made by
 * script has no handles or copy menu, but a touch tap inside a selection
 * without handles shows both (SelectionController::HandleTapInsideSelection).
 * So the shell selects the word by script and asks for that tap here: the
 * native handles and menu follow at once instead of after a long press.
 */
@CapacitorPlugin(name = "TouchSelection")
public class TouchSelectionPlugin extends Plugin {
    /** Long enough to be a tap, far below the long-press and tap timeouts. */
    private static final long TAP_MS = 40;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private long tapDownTime;
    private float tapX, tapY;
    private Runnable release;

    /** x and y in the WebView's own pixels, from the page's CSS pixels times devicePixelRatio. */
    @PluginMethod
    public void tapAt(PluginCall call) {
        Double x = call.getDouble("x");
        Double y = call.getDouble("y");
        if (x == null || y == null) { call.reject("x and y are required"); return; }
        getActivity().runOnUiThread(() -> {
            WebView view = getBridge().getWebView();
            realTouchStarted();
            tapDownTime = SystemClock.uptimeMillis();
            tapX = x.floatValue();
            tapY = y.floatValue();
            send(view, MotionEvent.ACTION_DOWN);
            release = () -> { release = null; send(view, MotionEvent.ACTION_UP); };
            handler.postDelayed(release, TAP_MS);
            call.resolve();
        });
    }

    /**
     * A touch while the tap is down, real or the next requested one, ends it
     * first: two touch streams at once confuse Chromium's gesture detector.
     */
    void realTouchStarted() {
        if (release == null) return;
        handler.removeCallbacks(release);
        release = null;
        send(getBridge().getWebView(), MotionEvent.ACTION_CANCEL);
    }

    private void send(WebView view, int action) {
        MotionEvent.PointerProperties properties = new MotionEvent.PointerProperties();
        properties.id = 0;
        properties.toolType = MotionEvent.TOOL_TYPE_FINGER;
        MotionEvent.PointerCoords coords = new MotionEvent.PointerCoords();
        coords.x = tapX;
        coords.y = tapY;
        coords.pressure = 1f;
        coords.size = 1f;
        MotionEvent event = MotionEvent.obtain(tapDownTime, SystemClock.uptimeMillis(), action, 1,
            new MotionEvent.PointerProperties[] { properties }, new MotionEvent.PointerCoords[] { coords },
            0, 0, 1f, 1f, 0, 0, InputDevice.SOURCE_TOUCHSCREEN, 0);
        view.dispatchTouchEvent(event);
        event.recycle();
    }
}
