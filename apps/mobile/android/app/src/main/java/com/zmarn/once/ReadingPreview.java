package com.zmarn.once;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Rect;
import android.util.Base64;
import android.util.Log;
import android.webkit.WebView;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.io.ByteArrayOutputStream;

/** Small, in-memory thumbnails of the visible content, never the browser chrome. */
final class ReadingPreview {
    private static final int WIDTH = 240;

    static void capture(ReadingSurfaceHost host, WebView shell, PluginCall call) {
        // A preview is optional: any failure settles the call empty, never leaves it pending.
        try {
            if (call.getBoolean("reader", false)) captureShell(shell, call);
            else if (host.surface == null || !host.surface.isShown() || !host.documentPainted) call.resolve();
            else host.surface.capturePixels().accept(image -> resolve(image, call), error -> call.resolve());
        } catch (RuntimeException | OutOfMemoryError error) {
            Log.w(ReadingSurfaceHost.TAG, "Preview capture failed", error);
            call.resolve();
        }
    }

    private static void captureShell(WebView shell, PluginCall call) {
        JSObject bounds = call.getObject("bounds", new JSObject());
        float density = shell.getResources().getDisplayMetrics().density;
        float x = (float) bounds.optDouble("x", 0) * density;
        float y = (float) bounds.optDouble("y", 0) * density;
        float width = (float) bounds.optDouble("width", 0) * density;
        float height = Math.min((float) bounds.optDouble("height", 0) * density, width * 1.2f);
        if (width <= 0 || height <= 0 || x < 0 || y < 0 || x + width > shell.getWidth() + 1 || y + height > shell.getHeight() + 1) { call.resolve(); return; }
        Bitmap image = Bitmap.createBitmap(WIDTH, Math.max(1, Math.round(height * WIDTH / width)), Bitmap.Config.ARGB_8888);
        try {
            Canvas canvas = new Canvas(image);
            canvas.scale(WIDTH / width, WIDTH / width);
            canvas.translate(-x, -y);
            shell.draw(canvas);
            call.resolve(encode(image));
        } finally { image.recycle(); }
    }

    /** Runs inside a GeckoResult callback, which swallows exceptions: settle here. */
    private static void resolve(Bitmap image, PluginCall call) {
        Bitmap small = null;
        try {
            // Crop and scale in one draw, and free the full-size capture before encoding.
            int height = Math.min(image.getHeight(), Math.max(1, Math.round(image.getWidth() * 1.2f)));
            small = Bitmap.createBitmap(WIDTH, Math.max(1, Math.round(height * (float) WIDTH / image.getWidth())), Bitmap.Config.ARGB_8888);
            new Canvas(small).drawBitmap(image, new Rect(0, 0, image.getWidth(), height),
                new Rect(0, 0, small.getWidth(), small.getHeight()), new Paint(Paint.FILTER_BITMAP_FLAG));
            image.recycle();
            call.resolve(encode(small));
        } catch (RuntimeException | OutOfMemoryError error) {
            Log.w(ReadingSurfaceHost.TAG, "Preview capture failed", error);
            call.resolve();
        } finally {
            if (small != null) small.recycle();
            if (!image.isRecycled()) image.recycle();
        }
    }

    private static JSObject encode(Bitmap image) {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        image.compress(Bitmap.CompressFormat.JPEG, 65, bytes);
        return new JSObject().put("dataUrl", "data:image/jpeg;base64," + Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP));
    }
}
