package com.zmarn.once.lite;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;

/**
 * A small JSON reader for Tier 2's rule files: objects become
 * {@link LinkedHashMap}s, arrays {@link ArrayList}s, numbers {@link Double}s
 * (or {@link Long}s when integral), plus strings, booleans and null. Plain
 * Java so the DNR evaluator and its JUnit tests need no Android classes;
 * {@link #forEachElement} walks a top-level array element by element, so a
 * 6 MB ruleset is never held as one object tree.
 */
public final class MiniJson {
    /** Nesting deeper than any rule has is refused, not recursed into until the stack runs out. */
    static final int MAX_DEPTH = 64;
    private final String text;
    private int at;
    private int depth;

    private MiniJson(String text) { this.text = text; }

    public static Object parse(String text) {
        MiniJson reader = new MiniJson(text);
        reader.space();
        Object value = reader.value();
        reader.space();
        if (reader.at != text.length()) throw reader.error("trailing characters");
        return value;
    }

    /** Calls {@code element} with each element of the top-level array {@code text}. */
    public static void forEachElement(String text, Consumer<Object> element) {
        MiniJson reader = new MiniJson(text);
        reader.space();
        reader.expect('[');
        reader.space();
        if (reader.peek() == ']') { reader.at++; return; }
        while (true) {
            reader.space();
            element.accept(reader.value());
            reader.space();
            char next = reader.next();
            if (next == ']') break;
            if (next != ',') throw reader.error("expected , or ]");
        }
    }

    private IllegalArgumentException error(String reason) {
        return new IllegalArgumentException("JSON: " + reason + " at " + at);
    }

    private char peek() {
        if (at >= text.length()) throw error("unexpected end");
        return text.charAt(at);
    }

    private char next() {
        char c = peek();
        at++;
        return c;
    }

    private void expect(char c) {
        if (next() != c) throw error("expected " + c);
    }

    private void space() {
        while (at < text.length()) {
            char c = text.charAt(at);
            if (c != ' ' && c != '\n' && c != '\r' && c != '\t') return;
            at++;
        }
    }

    private Object value() {
        char c = peek();
        switch (c) {
            case '{': case '[': {
                if (++depth > MAX_DEPTH) throw error("nested too deeply");
                Object nested = c == '{' ? object() : array();
                depth--;
                return nested;
            }
            case '"': return string();
            case 't': literal("true"); return Boolean.TRUE;
            case 'f': literal("false"); return Boolean.FALSE;
            case 'n': literal("null"); return null;
            default: return number();
        }
    }

    private void literal(String word) {
        if (!text.startsWith(word, at)) throw error("expected " + word);
        at += word.length();
    }

    private Map<String, Object> object() {
        expect('{');
        Map<String, Object> map = new LinkedHashMap<>();
        space();
        if (peek() == '}') { at++; return map; }
        while (true) {
            space();
            String key = string();
            space();
            expect(':');
            space();
            map.put(key, value());
            space();
            char next = next();
            if (next == '}') return map;
            if (next != ',') throw error("expected , or }");
        }
    }

    private List<Object> array() {
        expect('[');
        List<Object> list = new ArrayList<>();
        space();
        if (peek() == ']') { at++; return list; }
        while (true) {
            space();
            list.add(value());
            space();
            char next = next();
            if (next == ']') return list;
            if (next != ',') throw error("expected , or ]");
        }
    }

    private String string() {
        expect('"');
        int start = at;
        // The common case: no escapes, one substring.
        while (true) {
            char c = peek();
            if (c == '"') { String plain = text.substring(start, at); at++; return plain; }
            if (c == '\\') break;
            at++;
        }
        StringBuilder out = new StringBuilder(text.substring(start, at));
        while (true) {
            char c = next();
            if (c == '"') return out.toString();
            if (c != '\\') { out.append(c); continue; }
            char escape = next();
            switch (escape) {
                case '"': out.append('"'); break;
                case '\\': out.append('\\'); break;
                case '/': out.append('/'); break;
                case 'b': out.append('\b'); break;
                case 'f': out.append('\f'); break;
                case 'n': out.append('\n'); break;
                case 'r': out.append('\r'); break;
                case 't': out.append('\t'); break;
                case 'u':
                    if (at + 4 > text.length()) throw error("bad unicode escape");
                    out.append((char) Integer.parseInt(text.substring(at, at + 4), 16));
                    at += 4;
                    break;
                default: throw error("bad escape");
            }
        }
    }

    private Object number() {
        int start = at;
        while (at < text.length()) {
            char c = text.charAt(at);
            if ((c >= '0' && c <= '9') || c == '-' || c == '+' || c == '.' || c == 'e' || c == 'E') at++;
            else break;
        }
        if (start == at) throw error("unexpected character");
        String number = text.substring(start, at);
        try {
            if (number.indexOf('.') < 0 && number.indexOf('e') < 0 && number.indexOf('E') < 0) return Long.parseLong(number);
            return Double.parseDouble(number);
        } catch (NumberFormatException error) {
            throw error("bad number");
        }
    }
}
