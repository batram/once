package com.zmarn.once.lite;

import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import com.google.re2j.Pattern;

/**
 * Compiled DNR rules in a compact binary form, so uBlock Origin Lite's
 * 100k static rules are parsed from JSON once per app version rather than
 * on every Tier 2 start (JSON compiling takes seconds on a phone, reading
 * this a fraction of that). Strings are written once in a table and shared
 * by index, which also lets the rules share the instances when read back.
 * A CRC-32 trails the file and every count and index is checked on reading,
 * so a damaged file is refused (and compiled again) rather than trusted.
 */
final class DnrRuleCache {
    private static final int MAGIC = 0x4f6e6332; // "Onc2"
    private static final int VERSION = 3;
    /** Bounds a damaged file cannot get past: it is refused, never allocated. */
    private static final int MAX_COUNT = 4_000_000, MAX_LIST = 1_000_000, MAX_STRING = 64 * 1024 * 1024;

    private DnrRuleCache() {}

    static void write(DnrEvaluator.Compiled compiled, OutputStream target) throws IOException {
        java.util.zip.CRC32 crc = new java.util.zip.CRC32();
        DataOutputStream raw = new DataOutputStream(new java.io.BufferedOutputStream(target, 1 << 16));
        DataOutputStream out = new DataOutputStream(new java.util.zip.CheckedOutputStream(raw, crc));
        Map<String, Integer> table = new HashMap<>();
        List<String> strings = new ArrayList<>();
        for (DnrEvaluator.Rule rule : compiled.rules) for (String value : strings(rule)) {
            if (value != null && !table.containsKey(value)) { table.put(value, strings.size()); strings.add(value); }
        }
        out.writeInt(MAGIC);
        out.writeInt(VERSION);
        out.writeInt(compiled.skipped);
        out.writeInt(strings.size());
        for (String value : strings) writeLong(out, value);
        out.writeInt(compiled.rules.size());
        for (DnrEvaluator.Rule rule : compiled.rules) {
            out.writeInt(rule.id);
            out.writeInt(rule.priority);
            out.writeByte(rule.action);
            out.writeInt(rule.types);
            out.writeInt(rule.methods);
            out.writeBoolean(rule.anyMethod);
            out.writeByte(rule.domainType);
            writeStrings(out, table, rule.requestDomains);
            writeStrings(out, table, rule.excludedRequestDomains);
            writeStrings(out, table, rule.initiatorDomains);
            writeStrings(out, table, rule.excludedInitiatorDomains);
            writeInts(out, rule.tabIds);
            writeInts(out, rule.excludedTabIds);
            writeString(out, table, rule.filter == null ? null : rule.filter.source);
            out.writeBoolean(rule.filter != null && rule.filter.caseSensitive);
            writeString(out, table, rule.regex == null ? null : rule.regex.pattern());
            out.writeInt(rule.regex == null ? 0 : rule.regex.flags());
            writeString(out, table, rule.redirectUrl);
            writeString(out, table, rule.extensionPath);
            writeString(out, table, rule.regexSubstitution);
            writeString(out, table, rule.transform == null ? null : json(rule.transform));
        }
        out.flush();
        raw.writeLong(crc.getValue());
        raw.flush();
    }

    @SuppressWarnings("unchecked")
    static DnrEvaluator.Compiled read(InputStream source) throws IOException {
        java.util.zip.CRC32 crc = new java.util.zip.CRC32();
        DataInputStream raw = new DataInputStream(new java.io.BufferedInputStream(source, 1 << 16));
        DataInputStream in = new DataInputStream(new java.util.zip.CheckedInputStream(raw, crc));
        if (in.readInt() != MAGIC || in.readInt() != VERSION) throw new IOException("Not a compiled rules file of this version");
        DnrEvaluator.Compiled compiled = new DnrEvaluator.Compiled();
        compiled.skipped = in.readInt();
        String[] strings = new String[count(in.readInt(), MAX_COUNT)];
        for (int index = 0; index < strings.length; index++) strings[index] = readLong(in);
        int count = count(in.readInt(), MAX_COUNT);
        for (int index = 0; index < count; index++) {
            DnrEvaluator.Rule rule = new DnrEvaluator.Rule();
            rule.id = in.readInt();
            rule.priority = in.readInt();
            rule.action = in.readByte();
            if (rule.action < 0 || rule.action > 4) throw new IOException("Damaged rule action");
            rule.types = in.readInt();
            rule.methods = in.readInt();
            rule.anyMethod = in.readBoolean();
            rule.domainType = in.readByte();
            if (rule.domainType < 0 || rule.domainType > 2) throw new IOException("Damaged rule domain type");
            rule.requestDomains = readStrings(in, strings);
            rule.excludedRequestDomains = readStrings(in, strings);
            rule.initiatorDomains = readStrings(in, strings);
            rule.excludedInitiatorDomains = readStrings(in, strings);
            rule.tabIds = readInts(in);
            rule.excludedTabIds = readInts(in);
            String filter = readString(in, strings);
            boolean caseSensitive = in.readBoolean();
            if (filter != null) rule.filter = new DnrUrlFilter(filter, caseSensitive);
            String regex = readString(in, strings);
            int flags = in.readInt();
            if (regex != null) {
                try { rule.regex = Pattern.compile(regex, flags & Pattern.CASE_INSENSITIVE); }
                catch (RuntimeException error) { throw new IOException("Damaged rule regex", error); }
            }
            rule.redirectUrl = readString(in, strings);
            rule.extensionPath = readString(in, strings);
            rule.regexSubstitution = readString(in, strings);
            String transform = readString(in, strings);
            if (transform != null) {
                try { rule.transform = (Map<String, Object>) MiniJson.parse(transform); }
                catch (RuntimeException error) { throw new IOException("Damaged rule transform", error); }
            }
            if (rule.action == 4 && rule.redirectUrl == null && rule.extensionPath == null && rule.regexSubstitution == null && rule.transform == null) {
                throw new IOException("Damaged redirect rule");
            }
            if (rule.regexSubstitution != null && rule.regex == null) throw new IOException("Damaged regex substitution");
            compiled.rules.add(rule);
        }
        long expected = crc.getValue();
        if (raw.readLong() != expected) throw new IOException("The compiled rules file is damaged");
        return compiled;
    }

    private static int count(int value, int limit) throws IOException {
        if (value < 0 || value > limit) throw new IOException("Damaged count " + value);
        return value;
    }

    private static List<String> strings(DnrEvaluator.Rule rule) {
        List<String> values = new ArrayList<>();
        for (String[] list : new String[][] { rule.requestDomains, rule.excludedRequestDomains, rule.initiatorDomains, rule.excludedInitiatorDomains }) {
            if (list != null) for (String value : list) values.add(value);
        }
        values.add(rule.filter == null ? null : rule.filter.source);
        values.add(rule.regex == null ? null : rule.regex.pattern());
        values.add(rule.redirectUrl);
        values.add(rule.extensionPath);
        values.add(rule.regexSubstitution);
        values.add(rule.transform == null ? null : json(rule.transform));
        return values;
    }

    /** `writeUTF` stops at 64 KB; a regex or a transform may not. */
    private static void writeLong(DataOutputStream out, String value) throws IOException {
        byte[] bytes = value.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        out.writeInt(bytes.length);
        out.write(bytes);
    }

    private static String readLong(DataInputStream in) throws IOException {
        byte[] bytes = new byte[count(in.readInt(), MAX_STRING)];
        in.readFully(bytes);
        return new String(bytes, java.nio.charset.StandardCharsets.UTF_8);
    }

    private static void writeString(DataOutputStream out, Map<String, Integer> table, String value) throws IOException {
        out.writeInt(value == null ? -1 : table.get(value));
    }

    private static String readString(DataInputStream in, String[] strings) throws IOException {
        int index = in.readInt();
        if (index < -1 || index >= strings.length) throw new IOException("Damaged string index");
        return index < 0 ? null : strings[index];
    }

    private static void writeStrings(DataOutputStream out, Map<String, Integer> table, String[] values) throws IOException {
        if (values == null) { out.writeInt(-1); return; }
        out.writeInt(values.length);
        for (String value : values) out.writeInt(table.get(value));
    }

    private static String[] readStrings(DataInputStream in, String[] strings) throws IOException {
        int length = in.readInt();
        if (length < 0) return null;
        String[] values = new String[count(length, MAX_LIST)];
        for (int index = 0; index < length; index++) {
            int at = in.readInt();
            if (at < 0 || at >= strings.length) throw new IOException("Damaged string index");
            values[index] = strings[at];
        }
        return values;
    }

    private static void writeInts(DataOutputStream out, int[] values) throws IOException {
        if (values == null) { out.writeInt(-1); return; }
        out.writeInt(values.length);
        for (int value : values) out.writeInt(value);
    }

    private static int[] readInts(DataInputStream in) throws IOException {
        int length = in.readInt();
        if (length < 0) return null;
        int[] values = new int[count(length, MAX_LIST)];
        for (int index = 0; index < length; index++) values[index] = in.readInt();
        return values;
    }

    /** The JSON text of a parsed value (maps, lists, strings, numbers, booleans). */
    static String json(Object value) {
        StringBuilder out = new StringBuilder();
        append(out, value);
        return out.toString();
    }

    private static void append(StringBuilder out, Object value) {
        if (value == null) { out.append("null"); return; }
        if (value instanceof Map) {
            out.append('{');
            boolean first = true;
            for (Map.Entry<?, ?> entry : ((Map<?, ?>) value).entrySet()) {
                if (!first) out.append(',');
                first = false;
                append(out, String.valueOf(entry.getKey()));
                out.append(':');
                append(out, entry.getValue());
            }
            out.append('}');
        } else if (value instanceof List) {
            out.append('[');
            boolean first = true;
            for (Object entry : (List<?>) value) {
                if (!first) out.append(',');
                first = false;
                append(out, entry);
            }
            out.append(']');
        } else if (value instanceof String) {
            String text = (String) value;
            out.append('"');
            for (int index = 0; index < text.length(); index++) {
                char c = text.charAt(index);
                if (c == '"' || c == '\\') out.append('\\').append(c);
                else if (c < 0x20) out.append(String.format(java.util.Locale.ROOT, "\\u%04x", (int) c));
                else out.append(c);
            }
            out.append('"');
        } else out.append(value);
    }
}
