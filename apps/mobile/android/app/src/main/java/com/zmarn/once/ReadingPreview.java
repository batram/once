package com.zmarn.once;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.util.Base64;
import android.webkit.WebView;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.io.ByteArrayOutputStream;

/** Small, in-memory thumbnails of the visible content, never the browser chrome. */
final class ReadingPreview {
    static void capture(ReadingSurfaceHost host, WebView shell, PluginCall call) {
        if (call.getBoolean("reader", false)) {
            JSObject bounds = call.getObject("bounds", new JSObject());
            float density = shell.getResources().getDisplayMetrics().density;
            float x = (float) bounds.optDouble("x", 0) * density;
            float y = (float) bounds.optDouble("y", 0) * density;
            float width = (float) bounds.optDouble("width", 0) * density;
            float height = Math.min((float) bounds.optDouble("height", 0) * density, width * 1.2f);
            if (width <= 0 || height <= 0 || x < 0 || y < 0 || x + width > shell.getWidth() + 1 || y + height > shell.getHeight() + 1) { call.resolve(); return; }
            Bitmap image = Bitmap.createBitmap(240, Math.max(1, Math.round(height * 240 / width)), Bitmap.Config.ARGB_8888);
            Canvas canvas = new Canvas(image);
            canvas.scale(240 / width, 240 / width);
            canvas.translate(-x, -y);
            shell.draw(canvas);
            resolve(image, call);
        } else {
            if (host.surface == null || !host.surface.isShown() || !host.documentPainted) { call.resolve(); return; }
            host.surface.capturePixels().accept(image -> resolve(image, call), error -> call.resolve());
        }
    }

    private static void resolve(Bitmap image, PluginCall call) {
        Bitmap cropped = null;
        Bitmap small = null;
        try {
            int height = Math.min(image.getHeight(), Math.max(1, Math.round(image.getWidth() * 1.2f)));
            cropped = Bitmap.createBitmap(image, 0, 0, image.getWidth(), height);
            small = Bitmap.createScaledBitmap(cropped, 240, Math.max(1, Math.round(height * 240f / image.getWidth())), true);
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            small.compress(Bitmap.CompressFormat.JPEG, 65, bytes);
            call.resolve(new JSObject().put("dataUrl", "data:image/jpeg;base64," + Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP)));
        } finally {
            if (small != null && small != cropped && small != image) small.recycle();
            if (cropped != null && cropped != image) cropped.recycle();
            image.recycle();
        }
    }
}
