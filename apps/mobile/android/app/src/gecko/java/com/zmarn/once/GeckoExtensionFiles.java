package com.zmarn.once;

import android.content.Context;
import android.net.Uri;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;

final class GeckoExtensionFiles {
    /** Copies the chosen file off the UI thread, then answers on `handler` with the copy or the failure. */
    static void copyInBackground(Context context, Uri uri, android.os.Handler handler,
                                 java.util.function.Consumer<File> copied, java.util.function.Consumer<Exception> failed) {
        new Thread(() -> {
            try {
                File file = copy(context, uri);
                handler.post(() -> copied.accept(file));
            } catch (Exception error) { handler.post(() -> failed.accept(error)); }
        }, "once-extension-file").start();
    }

    static File copy(Context context, Uri uri) throws Exception {
        File file = File.createTempFile("once-extension-", ".xpi", context.getCacheDir());
        try (InputStream source = context.getContentResolver().openInputStream(uri);
             FileOutputStream target = new FileOutputStream(file)) {
            if (source == null) throw new IllegalArgumentException("The selected file is unavailable");
            byte[] buffer = new byte[16384];
            long total = 0;
            int count;
            while ((count = source.read(buffer)) != -1) {
                total += count;
                if (total > 200_000_000L) throw new IllegalArgumentException("Extension files must not exceed 200 MB");
                target.write(buffer, 0, count);
            }
            return file;
        } catch (Exception error) {
            file.delete();
            throw error;
        }
    }
}
