package com.zmarn.once.lite;

import android.util.Base64;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.net.ssl.HttpsURLConnection;
import org.json.JSONObject;

/**
 * `package.fetch` for the broker's AMO flow: HTTPS only, no credentials,
 * redirects answered as the 3xx they are (the broker re-requests, checking
 * each hop itself), bodies capped at the archive limit.
 */
final class LitePackages {
    private static final long BODY_LIMIT = 33L * 1024 * 1024;
    private static final int TIMEOUT_MS = 30000;
    private final ExecutorService network = Executors.newFixedThreadPool(2, runnable -> {
        Thread thread = new Thread(runnable, "once-lite-fetch");
        thread.setDaemon(true);
        return thread;
    });

    void register(BrokerChannel channel) {
        channel.onRequest("package.fetch", (params, reply) -> {
            String url = params.optString("url", "");
            network.execute(() -> {
                try { reply.resolve(fetch(url)); }
                catch (Exception error) { reply.reject(error.getMessage() == null ? error.toString() : error.getMessage()); }
            });
        });
    }

    void close() { network.shutdownNow(); }

    static JSONObject fetch(String url) throws Exception {
        URL target = new URL(url);
        if (!"https".equalsIgnoreCase(target.getProtocol())) throw new IOException("Only https sources can be fetched");
        HttpsURLConnection connection = (HttpsURLConnection) target.openConnection();
        connection.setInstanceFollowRedirects(false);
        connection.setUseCaches(false);
        connection.setConnectTimeout(TIMEOUT_MS);
        connection.setReadTimeout(TIMEOUT_MS);
        connection.setRequestProperty("Accept", "*/*");
        connection.setRequestProperty("User-Agent", "Once Lite");
        try {
            int status = connection.getResponseCode();
            JSONObject headers = new JSONObject();
            for (Map.Entry<String, List<String>> header : connection.getHeaderFields().entrySet()) {
                if (header.getKey() == null || header.getValue() == null || header.getValue().isEmpty()) continue;
                headers.put(header.getKey().toLowerCase(java.util.Locale.ROOT), header.getValue().get(header.getValue().size() - 1));
            }
            byte[] body = new byte[0];
            InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            if (stream != null && status != HttpURLConnection.HTTP_NO_CONTENT && status != HttpURLConnection.HTTP_NOT_MODIFIED) {
                try (InputStream in = stream) { body = LiteFiles.readAll(in, BODY_LIMIT); }
            }
            return new JSONObject().put("status", status).put("headers", headers).put("bodyBase64", Base64.encodeToString(body, Base64.NO_WRAP));
        } finally { connection.disconnect(); }
    }
}
