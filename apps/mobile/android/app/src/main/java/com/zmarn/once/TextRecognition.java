package com.zmarn.once;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;
import android.graphics.Point;
import android.graphics.Rect;
import android.util.Base64;
import androidx.exifinterface.media.ExifInterface;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import com.google.android.gms.tasks.Tasks;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;
import java.io.ByteArrayInputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.mozilla.geckoview.GeckoRuntime;

/** On-device ML Kit text recognition with the bundled Latin model (no Play services,
 * no model download). Limits and messages match iOS's TextRecognition.swift.
 * Recognition is independent of the visible tab; only the trusted shell bridge
 * can supply image bytes. Remote pages never receive this native capability. */
final class TextRecognition {
    private static final int MAX_BASE64_CHARS = 45_000_000;
    private static final int MAX_BYTES = 32 * 1024 * 1024;
    private static final double MAX_PIXELS = 80_000_000;
    private static final int MAX_SIDE = 4096;
    /** Caps the bitmap decoded before the exact downscale, at about 134 MB of ARGB. */
    private static final long MAX_DECODED_PIXELS = 2L * MAX_SIDE * MAX_SIDE;
    private static final ExecutorService worker = Executors.newSingleThreadExecutor();
    /** Loading the model costs over a second, so one client serves every call. */
    private static TextRecognizer recognizer;

    private TextRecognition() {}

    /**
     * Recognizes `{ base64 }` (the shell's text retrieval) or `{ url, referrer }`, an image of
     * the open page that Gecko fetches like Copy image does (the long-press "Select text in
     * image"). `lines` and `lineBounds` answer the retrieval port; `words` adds each word's
     * corners, normalized with a top-left origin, for the selection overlay.
     */
    static void recognize(PluginCall call, GeckoRuntime runtime) {
        String url = call.getString("url");
        if (url != null) {
            if (!url.startsWith("https://") && !url.startsWith("http://") && !url.startsWith("data:image/")) {
                call.reject("Invalid image");
                return;
            }
            String referrer = call.getString("referrer");
            worker.execute(() -> {
                byte[] fetched;
                try {
                    fetched = ImageShare.bytes(runtime, url, referrer);
                } catch (Throwable error) {
                    call.reject("Image unavailable");
                    return;
                }
                if (fetched.length == 0 || fetched.length > MAX_BYTES) call.reject("Invalid image size");
                else run(call, fetched);
            });
            return;
        }
        String encoded = call.getString("base64");
        byte[] data = null;
        if (encoded != null && encoded.length() <= MAX_BASE64_CHARS) {
            try {
                data = Base64.decode(encoded, Base64.DEFAULT);
            } catch (IllegalArgumentException ignored) {
                // Rejected below with the same message as an oversized image.
            }
        }
        if (data == null || data.length == 0 || data.length > MAX_BYTES) {
            call.reject("Invalid image size");
            return;
        }
        byte[] bytes = data;
        worker.execute(() -> run(call, bytes));
    }

    /** Decodes and recognizes on the worker thread, then answers the call. */
    private static void run(PluginCall call, byte[] bytes) {
        Bitmap image;
        try {
            image = decode(bytes);
        } catch (OutOfMemoryError | RuntimeException error) {
            image = null;
        }
        if (image == null) {
            call.reject("Invalid image");
            return;
        }
        try {
            Text text = Tasks.await(client().process(InputImage.fromBitmap(image, 0)));
            JSArray lines = new JSArray();
            JSArray bounds = new JSArray();
            JSArray words = new JSArray();
            for (Text.TextBlock block : text.getTextBlocks()) {
                for (Text.Line line : block.getLines()) {
                    Rect box = line.getBoundingBox();
                    if (box == null) box = new Rect();
                    lines.put(line.getText());
                    bounds.put(new JSObject()
                        .put("x", box.left).put("y", box.top)
                        .put("width", box.width()).put("height", box.height()));
                    words.put(words(line, image.getWidth(), image.getHeight()));
                }
            }
            call.resolve(new JSObject().put("lines", lines).put("lineBounds", bounds).put("words", words));
        } catch (Exception | OutOfMemoryError error) {
            call.reject("Image text recognition failed", error instanceof Exception ? (Exception) error : null);
        } finally {
            image.recycle();
        }
    }

    /** A line's words with their corners as fractions of the recognized image, top-left origin. */
    private static JSArray words(Text.Line line, int width, int height) {
        JSArray words = new JSArray();
        for (Text.Element element : line.getElements()) {
            // ML Kit lists corners clockwise from the top left.
            Point[] corners = element.getCornerPoints();
            Rect box = element.getBoundingBox();
            if ((corners == null || corners.length < 4) && box == null) continue;
            if (corners == null || corners.length < 4) corners = new Point[] {
                new Point(box.left, box.top), new Point(box.right, box.top),
                new Point(box.right, box.bottom), new Point(box.left, box.bottom) };
            words.put(new JSObject().put("text", element.getText())
                .put("topLeft", corner(corners[0], width, height))
                .put("topRight", corner(corners[1], width, height))
                .put("bottomLeft", corner(corners[3], width, height)));
        }
        return words;
    }

    private static JSObject corner(Point point, int width, int height) {
        return new JSObject().put("x", point.x / (double) width).put("y", point.y / (double) height);
    }

    private static synchronized TextRecognizer client() {
        if (recognizer == null) recognizer = com.google.mlkit.vision.text.TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);
        return recognizer;
    }

    /** Upright and at most MAX_SIDE on its longest side; null when not a decodable image. */
    private static Bitmap decode(byte[] bytes) {
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(bytes, 0, bytes.length, bounds);
        int width = bounds.outWidth;
        int height = bounds.outHeight;
        if (width <= 0 || height <= 0 || (double) width * height > MAX_PIXELS) return null;

        // Power-of-two subsampling happens during decoding; keep at least MAX_SIDE
        // so the exact scale below, not the subsampling, sets the final resolution.
        int sample = 1;
        while (Math.max(width, height) / (sample * 2) >= MAX_SIDE
            || (long) (width / sample) * (height / sample) > MAX_DECODED_PIXELS) sample *= 2;
        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inSampleSize = sample;
        Bitmap decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.length, options);
        if (decoded == null) return null;

        Matrix matrix = orientation(bytes);
        float scale = Math.min(1f, (float) MAX_SIDE / Math.max(decoded.getWidth(), decoded.getHeight()));
        matrix.preScale(scale, scale);
        if (matrix.isIdentity()) return decoded;
        Bitmap upright = Bitmap.createBitmap(decoded, 0, 0, decoded.getWidth(), decoded.getHeight(), matrix, true);
        if (upright != decoded) decoded.recycle();
        return upright;
    }

    /** The EXIF orientation as a transform; formats without EXIF are already upright. */
    private static Matrix orientation(byte[] bytes) {
        Matrix matrix = new Matrix();
        int value;
        try {
            value = new ExifInterface(new ByteArrayInputStream(bytes))
                .getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL);
        } catch (Exception ignored) {
            return matrix;
        }
        switch (value) {
            case ExifInterface.ORIENTATION_FLIP_HORIZONTAL: matrix.setScale(-1, 1); break;
            case ExifInterface.ORIENTATION_ROTATE_180: matrix.setRotate(180); break;
            case ExifInterface.ORIENTATION_FLIP_VERTICAL: matrix.setRotate(180); matrix.postScale(-1, 1); break;
            case ExifInterface.ORIENTATION_TRANSPOSE: matrix.setRotate(90); matrix.postScale(-1, 1); break;
            case ExifInterface.ORIENTATION_ROTATE_90: matrix.setRotate(90); break;
            case ExifInterface.ORIENTATION_TRANSVERSE: matrix.setRotate(-90); matrix.postScale(-1, 1); break;
            case ExifInterface.ORIENTATION_ROTATE_270: matrix.setRotate(-90); break;
            default: break;
        }
        return matrix;
    }
}
