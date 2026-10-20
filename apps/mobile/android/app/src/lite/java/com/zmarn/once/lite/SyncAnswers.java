package com.zmarn.once.lite;

import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.function.LongSupplier;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * The answers Java serves from memory to content worlds' synchronous
 * requests (`sync.set`): `https://<host>.moz-extension.localhost/_once/<key>/…?u=<document>`
 * → JSON text. The broker prepares one per document and extension before
 * the document continues; each is scoped to its target and frame and served once. The oldest paths go first
 * when documents never ask (a download, a frame without scripts).
 */
final class SyncAnswers {
    static final int LIMIT = 256;
    static final long BYTE_LIMIT = 16L * 1024 * 1024;
    static final long TTL_MS = 30_000;
    private static final class Answer {
        final String url, body, target, frame;
        final long at, bytes;
        Answer(String url, String body, String target, String frame, long at) {
            this.url = url; this.body = body; this.target = target; this.frame = frame; this.at = at;
            bytes = 2L * (url.length() + body.length() + target.length() + frame.length());
        }
    }
    private final Map<Long, Answer> answers = new LinkedHashMap<>();
    private final LongSupplier clock;
    private long next, bytes;

    SyncAnswers() { this(() -> System.nanoTime() / 1_000_000); }
    SyncAnswers(LongSupplier clock) { this.clock = clock; }

    synchronized void set(String url, String body) { set(url, body, "", ""); }

    synchronized void set(String url, String body, String target, String frame) {
        prune();
        if (body == null) { removeIf(answer -> answer.url.equals(url) && answer.target.equals(target) && answer.frame.equals(frame)); return; }
        Answer answer = new Answer(url, body, target, frame, clock.getAsLong());
        if (answer.bytes > BYTE_LIMIT) throw new IllegalArgumentException("Document answer exceeds the memory budget");
        answers.put(++next, answer);
        bytes += answer.bytes;
        Iterator<Answer> oldest = answers.values().iterator();
        while (answers.size() > LIMIT || bytes > BYTE_LIMIT) { bytes -= oldest.next().bytes; oldest.remove(); }
    }

    synchronized String take(String url) { return take(url, "", ""); }

    synchronized String take(String url, String target, String frame) {
        prune();
        for (Iterator<Answer> entries = answers.values().iterator(); entries.hasNext(); ) {
            Answer answer = entries.next();
            if (!answer.url.equals(url) || !answer.target.equals(target) || !answer.frame.equals(frame)) continue;
            entries.remove(); bytes -= answer.bytes;
            return answer.body;
        }
        return null;
    }

    synchronized void forgetTarget(String target) { removeIf(answer -> answer.target.equals(target)); }
    synchronized void forgetFrame(String target, String frame) { removeIf(answer -> answer.target.equals(target) && answer.frame.equals(frame)); }
    synchronized void clear() { answers.clear(); bytes = 0; }
    synchronized int size() { prune(); return answers.size(); }
    synchronized long bytes() { prune(); return bytes; }

    private void prune() { long cutoff = clock.getAsLong() - TTL_MS; removeIf(answer -> answer.at <= cutoff); }
    private void removeIf(java.util.function.Predicate<Answer> predicate) {
        for (Iterator<Answer> entries = answers.values().iterator(); entries.hasNext(); ) {
            Answer answer = entries.next();
            if (predicate.test(answer)) { bytes -= answer.bytes; entries.remove(); }
        }
    }

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
