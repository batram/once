package com.zmarn.once.lite;

import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * The answers Java serves from memory to content worlds' synchronous
 * requests (`sync.set`): `https://<host>.moz-extension.localhost/_once/<key>/…?u=<document>`
 * → JSON text. The broker prepares one per document and extension before
 * the document continues; each is served once, in the order stored, so two
 * tabs loading the same URL each get their own. The oldest paths go first
 * when documents never ask (a download, a frame without scripts).
 */
final class SyncAnswers {
    static final int LIMIT = 256;

    private final Map<String, ArrayDeque<String>> answers = new LinkedHashMap<String, ArrayDeque<String>>(16, 0.75f, false) {
        @Override protected boolean removeEldestEntry(Map.Entry<String, ArrayDeque<String>> eldest) { return size() > LIMIT; }
    };

    /** Stores a body under the URL, or forgets every body under it. */
    synchronized void set(String url, String body) {
        if (body == null) { answers.remove(url); return; }
        ArrayDeque<String> queue = answers.remove(url);
        if (queue == null) queue = new ArrayDeque<>();
        queue.add(body);
        // Re-inserted, so the path counts as the newest.
        answers.put(url, queue);
    }

    /** The next body stored under the URL, now served; null when there is none. */
    synchronized String take(String url) {
        ArrayDeque<String> queue = answers.get(url);
        if (queue == null) return null;
        String body = queue.poll();
        if (queue.isEmpty()) answers.remove(url);
        return body;
    }

    synchronized int size() { return answers.size(); }

    /** Whether the URL names a synchronous answer (`/_once/` on an extension origin). */
    static boolean isSyncRequest(String url) {
        int query = url.indexOf('?');
        return (query < 0 ? url : url.substring(0, query)).contains(LitePage.PAGE_HOST_SUFFIX + "/_once/");
    }

    /**
     * Who may read the answer: the document the request names in `u` (its
     * worlds' requests carry its origin, or `null` in a sandboxed frame).
     * Null when the request comes from another origin, which is then refused
     * without taking the answer.
     */
    static String allowedOrigin(String url, String requestOrigin) {
        String document = origin(queryParameter(url, "u"));
        if (document == null) return null;
        if (requestOrigin == null || requestOrigin.isEmpty()) return document;
        if (requestOrigin.equals(document) || requestOrigin.equals("null")) return requestOrigin;
        return null;
    }

    static String queryParameter(String url, String name) {
        int query = url.indexOf('?');
        if (query < 0) return null;
        int hash = url.indexOf('#', query);
        for (String pair : url.substring(query + 1, hash < 0 ? url.length() : hash).split("&")) {
            int equals = pair.indexOf('=');
            if (equals < 0 || !pair.substring(0, equals).equals(name)) continue;
            try { return URLDecoder.decode(pair.substring(equals + 1), StandardCharsets.UTF_8.name()); }
            catch (Exception error) { return null; }
        }
        return null;
    }

    /** `scheme://host[:port]` of an http(s) URL, as browsers serialise an origin; null otherwise. */
    static String origin(String url) {
        if (url == null) return null;
        // By hand rather than java.net.URI, which refuses characters Chromium leaves unescaped in a path.
        int separator = url.indexOf("://");
        if (separator < 0) return null;
        String scheme = url.substring(0, separator).toLowerCase(java.util.Locale.ROOT);
        if (!scheme.equals("https") && !scheme.equals("http")) return null;
        int end = separator + 3;
        while (end < url.length() && "/?#".indexOf(url.charAt(end)) < 0) end++;
        String authority = url.substring(separator + 3, end);
        authority = authority.substring(authority.lastIndexOf('@') + 1).toLowerCase(java.util.Locale.ROOT);
        int colon = authority.lastIndexOf(':');
        if (colon > authority.lastIndexOf(']')) {
            String port = authority.substring(colon + 1);
            if (port.isEmpty() || scheme.equals("https") && port.equals("443") || scheme.equals("http") && port.equals("80")) authority = authority.substring(0, colon);
        }
        return authority.isEmpty() ? null : scheme + "://" + authority;
    }
}
