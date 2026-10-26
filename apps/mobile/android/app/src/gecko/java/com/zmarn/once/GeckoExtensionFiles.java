package com.zmarn.once;

import android.content.Context;
import android.net.Uri;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;

final class GeckoExtensionFiles {
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
