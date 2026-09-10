package com.zmarn.once;

import android.graphics.Bitmap;
import android.util.Base64;
import java.io.ByteArrayOutputStream;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.mozilla.geckoview.WebExtension;

/** Small PNGs cross the shell bridge; extension resource URLs stay inside Gecko. */
final class GeckoExtensionIcons {
    private final Map<String, String> images = new HashMap<>();
    private final Set<String> requested = new HashSet<>();
    private final Runnable changed;

    GeckoExtensionIcons(Runnable changed) { this.changed = changed; }

    private String key(WebExtension extension) { return extension.id + ":" + extension.metaData.version; }

    String get(WebExtension extension) { return images.getOrDefault(key(extension), ""); }

    void adopt(List<WebExtension> extensions) {
        Set<String> installed = new HashSet<>();
        for (WebExtension extension : extensions) {
            if (extension.metaData == null || GeckoEngine.BRIDGE_ID.equals(extension.id)) continue;
            String key = key(extension);
            installed.add(key);
            if (extension.metaData.icon == null || !requested.add(key)) continue;
            extension.metaData.icon.getBitmap(40).accept(bitmap -> {
                if (bitmap == null || !requested.contains(key)) return;
                Bitmap small = Bitmap.createScaledBitmap(bitmap, 40, 40, true);
                ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                small.compress(Bitmap.CompressFormat.PNG, 100, bytes);
                images.put(key, "data:image/png;base64," + Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP));
                changed.run();
            }, ignored -> { /* Keep the title's fallback icon when the package has no usable image. */ });
        }
        requested.retainAll(installed);
        images.keySet().retainAll(installed);
    }
}
