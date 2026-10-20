package com.zmarn.once.lite;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.util.Base64;

/**
 * A JSON object document kept one level deep as files: a directory with one
 * file per top-level key, holding the raw JSON text of the value. The
 * broker's `store.patch` then replaces single keys of documents that run to
 * tens of megabytes (uBlock's storage) without Java ever holding the
 * document, let alone an object tree of it. Splitting an existing document
 * streams it once; reading streams the files back into one text.
 */
final class ShallowJson {
    private ShallowJson() {}

    /** File names stay below the 255 bytes file systems take; base64 grows a key by a third. */
    private static final int NAME_LIMIT = 200;
    /** A long key's name: `~` (never in base64url) and its SHA-256; the key itself is beside it in `<name>.key`. */
    private static final String HASHED = "~";
    private static final String KEY_SUFFIX = ".key";

    /** The file a key lives in: URL-safe base64 of its UTF-8, so any key is a file name, or its hash when that is too long. */
    static File keyFile(File directory, String key) {
        String encoded = Base64.getUrlEncoder().withoutPadding().encodeToString(key.getBytes(StandardCharsets.UTF_8));
        return new File(directory, !encoded.isEmpty() && encoded.length() <= NAME_LIMIT ? encoded : HASHED + sha256(key));
    }

    /** Where a long key's text is kept; null for a key spelled in its file name. */
    static File keyNameFile(File valueFile) {
        return valueFile.getName().startsWith(HASHED) ? new File(valueFile.getParentFile(), valueFile.getName() + KEY_SUFFIX) : null;
    }

    /** Places the key's text beside its value when the file name cannot carry it. */
    static void recordKey(File valueFile, String key) throws IOException {
        File name = keyNameFile(valueFile);
        if (name != null) writeAtomically(name, key);
    }

    /** Removes a key's value and, for a long key, its name. */
    static void deleteKey(File directory, String key) {
        File value = keyFile(directory, key);
        //noinspection ResultOfMethodCallIgnored
        value.delete();
        File name = keyNameFile(value);
        //noinspection ResultOfMethodCallIgnored
        if (name != null) name.delete();
    }

    static String keyOf(File file) throws IOException {
        File name = keyNameFile(file);
        if (name != null) return new String(java.nio.file.Files.readAllBytes(name.toPath()), StandardCharsets.UTF_8);
        return new String(Base64.getUrlDecoder().decode(file.getName()), StandardCharsets.UTF_8);
    }

    private static String sha256(String text) {
        try {
            byte[] digest = java.security.MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder();
            for (byte b : digest) hex.append(String.format(java.util.Locale.ROOT, "%02x", b));
            return hex.toString();
        } catch (java.security.NoSuchAlgorithmException error) {
            throw new IllegalStateException(error);
        }
    }

    /** Streams `{"key": value, ...}` from the directory's files into `out`. */
    static void join(File directory, Writer out) throws IOException {
        join(directory, out, null);
    }

    /** Keyed reads open only requested files; large unrelated values stay on disk. */
    static void join(File directory, Writer out, java.util.Set<String> keys) throws IOException {
        File[] files = keys == null ? directory.listFiles()
            : keys.stream().map(key -> keyFile(directory, key)).toArray(File[]::new);
        out.write('{');
        boolean first = true;
        if (files != null) for (File file : files) {
            if (!file.isFile() || file.getName().endsWith(".tmp") || file.getName().endsWith(KEY_SUFFIX)) continue;
            if (!first) out.write(',');
            first = false;
            out.write(org.json.JSONObject.quote(keyOf(file)));
            out.write(':');
            try (BufferedReader in = new BufferedReader(new InputStreamReader(new FileInputStream(file), StandardCharsets.UTF_8))) {
                char[] buffer = new char[16384];
                for (int read; (read = in.read(buffer)) != -1; ) out.write(buffer, 0, read);
            }
        }
        out.write('}');
    }

    /** Selects keys from a legacy unsplit document without materializing discarded values. */
    static void select(File file, Writer out, java.util.Set<String> keys) throws IOException {
        try (BufferedReader in = new BufferedReader(new InputStreamReader(new FileInputStream(file), StandardCharsets.UTF_8), 65536)) {
            Scanner scanner = new Scanner(in);
            Writer discard = new Writer() {
                @Override public void write(char[] buffer, int offset, int length) {}
                @Override public void write(int value) {}
                @Override public void flush() {}
                @Override public void close() {}
            };
            scanner.expect('{');
            out.write('{');
            boolean first = true;
            if (scanner.peekSkippingSpace() != '}') for (;;) {
                String key = scanner.readString();
                scanner.expect(':');
                scanner.peekSkippingSpace();
                boolean selected = keys.contains(key);
                if (selected) {
                    if (!first) out.write(',');
                    first = false;
                    out.write(org.json.JSONObject.quote(key));
                    out.write(':');
                }
                scanner.copyValue(selected ? out : discard);
                int next = scanner.peekSkippingSpace();
                if (next == '}') break;
                if (next != ',') throw new IOException("Malformed store document");
                scanner.read();
            }
            scanner.expect('}');
            if (scanner.peekSkippingSpace() != -1) throw new IOException("Trailing store document content");
            out.write('}');
        }
    }

    /** Streams the object document in `file` into one file per top-level key under `directory`. */
    static void split(File file, File directory) throws IOException {
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("Could not create " + directory.getName());
        try (BufferedReader in = new BufferedReader(new InputStreamReader(new FileInputStream(file), StandardCharsets.UTF_8), 65536)) {
            Scanner scanner = new Scanner(in);
            scanner.expect('{');
            if (scanner.peekSkippingSpace() == '}') return;
            for (;;) {
                String key = scanner.readString();
                scanner.expect(':');
                scanner.peekSkippingSpace();
                File target = keyFile(directory, key);
                try (Writer out = new OutputStreamWriter(new FileOutputStream(target), StandardCharsets.UTF_8)) { scanner.copyValue(out); }
                recordKey(target, key);
                int next = scanner.peekSkippingSpace();
                if (next == '}') return;
                if (next != ',') throw new IOException("Malformed store document");
                scanner.read();
            }
        }
    }

    /** A one-character-lookahead reader over the document. */
    private static final class Scanner {
        private final BufferedReader in;
        private int peeked = -2;

        Scanner(BufferedReader in) { this.in = in; }

        int peek() throws IOException {
            if (peeked == -2) peeked = in.read();
            return peeked;
        }

        int read() throws IOException {
            int value = peek();
            peeked = -2;
            return value;
        }

        int peekSkippingSpace() throws IOException {
            while (peek() != -1 && Character.isWhitespace(peek())) read();
            return peek();
        }

        void expect(char expected) throws IOException {
            if (peekSkippingSpace() != expected) throw new IOException("Malformed store document: expected " + expected);
            read();
        }

        /** A JSON string, decoded. */
        String readString() throws IOException {
            if (peekSkippingSpace() != '"') throw new IOException("Malformed store document: expected a key");
            StringBuilder raw = new StringBuilder();
            copyString(raw);
            try { return String.valueOf(new org.json.JSONTokener(raw.toString()).nextValue()); }
            catch (org.json.JSONException error) { throw new IOException("Malformed key in store document", error); }
        }

        /** Copies the string at the cursor, quotes included. */
        private void copyString(Appendable out) throws IOException {
            out.append((char) read());
            for (;;) {
                int c = read();
                if (c == -1) throw new IOException("Unterminated string in store document");
                out.append((char) c);
                if (c == '\\') { int escaped = read(); if (escaped == -1) throw new IOException("Unterminated string"); out.append((char) escaped); continue; }
                if (c == '"') return;
            }
        }

        /** Copies the value at the cursor: a string, a nested object or array, or a bare token. */
        void copyValue(Writer out) throws IOException {
            int start = peek();
            if (start == '"') { copyString(out); return; }
            if (start == '{' || start == '[') {
                int depth = 0;
                for (;;) {
                    int c = peek();
                    if (c == -1) throw new IOException("Unterminated value in store document");
                    if (c == '"') { copyString(out); continue; }
                    read();
                    out.write(c);
                    if (c == '{' || c == '[') depth++;
                    else if (c == '}' || c == ']') { if (--depth == 0) return; }
                }
            }
            for (;;) {
                int c = peek();
                if (c == -1 || c == ',' || c == '}' || c == ']' || Character.isWhitespace(c)) return;
                out.write(read());
            }
        }
    }

    /** Writes the text to the file through a sibling, so readers see the old or the new content. */
    static void writeAtomically(File file, String text) throws IOException {
        File temp = new File(file.getParentFile(), file.getName() + ".tmp");
        try (OutputStream out = new FileOutputStream(temp)) { out.write(text.getBytes(StandardCharsets.UTF_8)); }
        if (!temp.renameTo(file)) throw new IOException("Could not replace " + file.getName());
    }
}
