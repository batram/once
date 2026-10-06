package com.zmarn.once;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.util.Log;
import android.webkit.MimeTypeMap;
import android.widget.Toast;
import androidx.core.content.FileProvider;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.mozilla.geckoview.GeckoRuntime;
import org.mozilla.geckoview.GeckoWebExecutor;
import org.mozilla.geckoview.WebRequest;
import org.mozilla.geckoview.WebResponse;

/** Copies, shares or saves an image's bytes, not its address. Gecko fetches it with
 * the page's cookies; the file is handed out through the app's FileProvider. */
final class ImageShare {
    private static final String TAG = "OnceImageShare";
    private static final long FETCH_TIMEOUT_MS = 30000;
    private static final int MAX_BYTES = 25 * 1024 * 1024;
    private static final ExecutorService worker = Executors.newSingleThreadExecutor();

    private ImageShare() {}

    /** MediaStore needs no storage permission from Android 10 on. */
    static boolean canSave() { return Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q; }

    static void copy(Activity activity, GeckoRuntime runtime, String src, String referrer) {
        load(activity, runtime, src, referrer, image -> {
            Uri uri = cacheFile(activity, image);
            return () -> {
                ClipboardManager clipboard = (ClipboardManager) activity.getSystemService(Context.CLIPBOARD_SERVICE);
                // Android 13+ confirms clipboard writes itself.
                if (clipboard != null) clipboard.setPrimaryClip(ClipData.newUri(activity.getContentResolver(), "Image", uri));
            };
        });
    }

    static void share(Activity activity, GeckoRuntime runtime, String src, String referrer) {
        load(activity, runtime, src, referrer, image -> {
            Uri uri = cacheFile(activity, image);
            return () -> {
                Intent send = new Intent(Intent.ACTION_SEND)
                    .setType(image.mime)
                    .putExtra(Intent.EXTRA_STREAM, uri)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                // Lets the chooser show a thumbnail of what is being shared.
                send.setClipData(ClipData.newRawUri(null, uri));
                activity.startActivity(Intent.createChooser(send, null));
            };
        });
    }

    /** Saves into Downloads, where Files and the gallery's device folders show it. */
    static void save(Activity activity, GeckoRuntime runtime, String src, String referrer) {
        if (!canSave()) return;
        load(activity, runtime, src, referrer, image -> {
            ContentResolver resolver = activity.getContentResolver();
            ContentValues values = new ContentValues();
            values.put(MediaStore.MediaColumns.DISPLAY_NAME, fileName(src, image.mime));
            values.put(MediaStore.MediaColumns.MIME_TYPE, image.mime);
            values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
            values.put(MediaStore.MediaColumns.IS_PENDING, 1);
            Uri item = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (item == null) throw new IOException("Downloads unavailable");
            try (OutputStream out = resolver.openOutputStream(item)) {
                if (out == null) throw new IOException("Downloads unavailable");
                out.write(image.bytes);
            } catch (IOException error) {
                resolver.delete(item, null, null);
                throw error;
            }
            values.clear();
            values.put(MediaStore.MediaColumns.IS_PENDING, 0);
            resolver.update(item, values, null, null);
            return () -> Toast.makeText(activity, "Image saved to Downloads", Toast.LENGTH_SHORT).show();
        });
    }

    /** Runs on the worker with the loaded image; returns what to do on the UI thread. */
    private interface Step { Runnable run(Fetched image) throws Throwable; }

    private static void load(Activity activity, GeckoRuntime runtime, String src, String referrer, Step step) {
        worker.execute(() -> {
            try {
                Fetched image = src.startsWith("data:") ? decode(src) : fetch(runtime, src, referrer);
                activity.runOnUiThread(step.run(image));
            } catch (Throwable error) {
                Log.w(TAG, "Image unavailable: " + error);
                activity.runOnUiThread(() ->
                    Toast.makeText(activity, "Couldn't load the image", Toast.LENGTH_SHORT).show());
            }
        });
    }

    private static Uri cacheFile(Activity activity, Fetched image) throws IOException {
        // One file, replaced each time: a receiving app reads it right away.
        File dir = new File(activity.getCacheDir(), "shared-images");
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("No cache directory");
        File file = new File(dir, "image." + extension(image.mime));
        try (OutputStream out = new FileOutputStream(file)) { out.write(image.bytes); }
        return FileProvider.getUriForFile(activity, activity.getPackageName() + ".fileprovider", file);
    }

    /** The URL's last path segment, with the extension the MIME type implies. */
    private static String fileName(String src, String mime) {
        String name = src.startsWith("data:") ? null : Uri.parse(src).getLastPathSegment();
        if (name == null || name.isEmpty()) name = "image";
        name = name.replaceAll("[\\\\/:*?\"<>|]", "_");
        int dot = name.lastIndexOf('.');
        String base = dot > 0 ? name.substring(0, dot) : name;
        if (base.length() > 100) base = base.substring(0, 100);
        return base + "." + extension(mime);
    }

    private static final class Fetched {
        final byte[] bytes;
        final String mime;
        Fetched(byte[] bytes, String mime) { this.bytes = bytes; this.mime = mime; }
    }

    private static Fetched fetch(GeckoRuntime runtime, String src, String referrer) throws Throwable {
        WebRequest.Builder request = new WebRequest.Builder(src).header("Accept", "image/*");
        if (referrer != null) request.referrer(referrer);
        // poll blocks, so this runs on the worker thread, never the UI thread.
        WebResponse response = new GeckoWebExecutor(runtime).fetch(request.build()).poll(FETCH_TIMEOUT_MS);
        if (response.statusCode < 200 || response.statusCode > 299 || response.body == null) {
            throw new IOException("HTTP " + response.statusCode);
        }
        String mime = mimeOf(response.headers.get("Content-Type"));
        if (mime == null) mime = mimeOf(response.headers.get("content-type"));
        try (InputStream body = response.body) {
            return new Fetched(readAll(body), requireImage(mime));
        }
    }

    private static Fetched decode(String src) throws IOException {
        int comma = src.indexOf(',');
        String meta = comma < 0 ? "" : src.substring(5, comma);
        if (!meta.endsWith(";base64")) throw new IOException("Unsupported data URI");
        String mime = requireImage(mimeOf(meta.substring(0, meta.length() - ";base64".length())));
        return new Fetched(Base64.decode(src.substring(comma + 1), Base64.DEFAULT), mime);
    }

    private static byte[] readAll(InputStream in) throws IOException {
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        byte[] buffer = new byte[64 * 1024];
        for (int read; (read = in.read(buffer)) != -1; ) {
            out.write(buffer, 0, read);
            if (out.size() > MAX_BYTES) throw new IOException("Image too large");
        }
        return out.toByteArray();
    }

    private static String mimeOf(String contentType) {
        if (contentType == null) return null;
        String mime = contentType.split(";", 2)[0].trim().toLowerCase(java.util.Locale.ROOT);
        return mime.isEmpty() ? null : mime;
    }

    private static String requireImage(String mime) throws IOException {
        if (mime == null || !mime.startsWith("image/")) throw new IOException("Not an image: " + mime);
        return mime;
    }

    private static String extension(String mime) {
        String extension = MimeTypeMap.getSingleton().getExtensionFromMimeType(mime);
        return extension != null ? extension : "img";
    }
}
