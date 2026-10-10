package com.zmarn.once;

import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.util.List;
import java.util.Map;

/**
 * Downloads a document for Reader with a byte cap enforced while reading, so
 * a server that misreports or omits Content-Length cannot fill memory before
 * the shell's own limit applies. Only the trusted shell bridge reaches it, it
 * follows redirects, and cookies travel only when asked to.
 */
final class DocumentDownload {
    private DocumentDownload() {}

    static void fetch(PluginCall call) {
        String target = call.getString("url");
        android.net.Uri parsed = target == null ? null : android.net.Uri.parse(target);
        String scheme = parsed == null || parsed.getScheme() == null ? "" : parsed.getScheme().toLowerCase(java.util.Locale.ROOT);
        if (!scheme.equals("http") && !scheme.equals("https")) { call.reject("Invalid document URL"); return; }
        int limit = Math.min(Math.max(call.getInt("maxBytes", 0), 1), 256 * 1024 * 1024);
        boolean includeCredentials = "include".equals(call.getString("credentials"));
        JSObject requested = call.getObject("headers", new JSObject());
        new Thread(() -> {
            java.net.HttpURLConnection connection = null;
            try {
                connection = (java.net.HttpURLConnection) new java.net.URL(target).openConnection();
                connection.setConnectTimeout(30_000);
                connection.setReadTimeout(60_000);
                connection.setInstanceFollowRedirects(true);
                connection.setRequestProperty("Cookie", "");
                for (java.util.Iterator<String> names = requested.keys(); names.hasNext();) {
                    String name = names.next();
                    if (name.equalsIgnoreCase("cookie") && !includeCredentials) continue;
                    String value = requested.getString(name);
                    if (value != null) connection.setRequestProperty(name, value);
                }
                if (includeCredentials) {
                    String cookies = android.webkit.CookieManager.getInstance().getCookie(target);
                    if (cookies != null) connection.setRequestProperty("Cookie", cookies);
                }
                int status = connection.getResponseCode();
                if (connection.getContentLengthLong() > limit) { call.reject("Document too large"); return; }
                java.io.InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
                java.io.ByteArrayOutputStream buffer = new java.io.ByteArrayOutputStream();
                if (stream != null) {
                    byte[] chunk = new byte[64 * 1024];
                    int read;
                    while ((read = stream.read(chunk)) != -1) {
                        if (buffer.size() + read > limit) { call.reject("Document too large"); return; }
                        buffer.write(chunk, 0, read);
                    }
                }
                JSObject headers = new JSObject();
                for (Map.Entry<String, List<String>> header : connection.getHeaderFields().entrySet()) {
                    if (header.getKey() != null && !header.getValue().isEmpty()) headers.put(header.getKey(), header.getValue().get(0));
                }
                JSObject result = new JSObject();
                result.put("status", status);
                result.put("url", connection.getURL().toString());
                result.put("headers", headers);
                result.put("base64", android.util.Base64.encodeToString(buffer.toByteArray(), android.util.Base64.NO_WRAP));
                call.resolve(result);
            } catch (Exception error) {
                call.reject(error.getMessage() == null ? "Document download failed" : error.getMessage());
            } finally {
                if (connection != null) connection.disconnect();
            }
        }, "once-document-download").start();
    
    }
}
