package com.zmarn.once;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.json.JSONObject;

/** Resolve a listing to its Android package. Gecko verifies the downloaded XPI signature. */
final class GeckoExtensionSource {
    private static final Pattern LISTING = Pattern.compile("^/(?:[A-Za-z-]+/)?(?:firefox|android)/addon/([A-Za-z0-9_-]+)/?$");

    static String resolve(String source) throws Exception {
        URI uri = new URI(source);
        if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getUserInfo() != null || uri.getPort() != -1) {
            throw new IllegalArgumentException("Use an HTTPS Firefox Add-ons URL or choose a signed XPI file");
        }
        if (!"addons.mozilla.org".equalsIgnoreCase(uri.getHost())) {
            throw new IllegalArgumentException("Use a Firefox Add-ons listing from addons.mozilla.org");
        }
        Matcher listing = LISTING.matcher(uri.getPath());
        if (!listing.matches()) throw new IllegalArgumentException("Enter a Firefox Add-ons extension listing URL");
        JSONObject addon = new JSONObject(read("https://addons.mozilla.org/api/v5/addons/addon/" + listing.group(1) + "/"));
        JSONObject version = addon.optJSONObject("current_version");
        JSONObject file = version == null ? null : version.optJSONObject("file");
        if (file == null) throw new IllegalArgumentException("This listing has no installable extension package");
        // AMO's API normally uses a scalar platform and compatibility.android.
        JSONObject compatibility = version.optJSONObject("compatibility");
        if (compatibility == null || !compatibility.has("android")) {
            throw new IllegalArgumentException("This extension version is not listed as compatible with Firefox for Android");
        }
        String url = file.getString("url");
        URI download = new URI(url);
        if (!"https".equals(download.getScheme()) || download.getUserInfo() != null ||
            !("addons.mozilla.org".equals(download.getHost()) || "addons.cdn.mozilla.net".equals(download.getHost()))) {
            throw new IllegalArgumentException("The listing returned an unsupported download address");
        }
        return url;
    }

    private static String read(String url) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URI(url).toURL().openConnection();
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(20000);
        connection.setInstanceFollowRedirects(false);
        connection.setRequestProperty("Accept", "application/json");
        try {
            if (connection.getResponseCode() != 200) throw new IllegalStateException("Firefox Add-ons returned HTTP " + connection.getResponseCode());
            try (InputStream stream = connection.getInputStream(); ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[8192];
                int count;
                while ((count = stream.read(buffer)) != -1) {
                    if (bytes.size() + count > 2 * 1024 * 1024) throw new IllegalStateException("Add-ons listing is too large");
                    bytes.write(buffer, 0, count);
                }
                return bytes.toString(StandardCharsets.UTF_8.name());
            }
        } finally { connection.disconnect(); }
    }
}
