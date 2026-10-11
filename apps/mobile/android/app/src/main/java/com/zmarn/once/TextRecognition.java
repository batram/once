package com.zmarn.once;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;
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

    static void recognize(PluginCall call) {
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
        worker.execute(() -> {
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
                for (Text.TextBlock block : text.getTextBlocks()) {
                    for (Text.Line line : block.getLines()) {
                        Rect box = line.getBoundingBox();
                        if (box == null) box = new Rect();
                        lines.put(line.getText());
                        bounds.put(new JSObject()
                            .put("x", box.left).put("y", box.top)
                            .put("width", box.width()).put("height", box.height()));
                    }
                }
                call.resolve(new JSObject().put("lines", lines).put("lineBounds", bounds));
            } catch (Exception | OutOfMemoryError error) {
                call.reject("Image text recognition failed", error instanceof Exception ? (Exception) error : null);
            } finally {
                image.recycle();
            }
        });
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
