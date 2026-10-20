package com.zmarn.once.lite;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * One {@code urlFilter} of Tier 2's DNR rules (DnrEvaluator): {@code ||}
 * anchors at a domain boundary after the scheme, {@code |} at either end,
 * {@code *} is anything, {@code ^} a separator or the end of the URL.
 */
final class DnrUrlFilter {
    /** As the rule wrote it, for the compiled-rules cache. */
    final String source;
    final char[] pattern;
    final boolean domainAnchor, startAnchor, endAnchor, caseSensitive;

    DnrUrlFilter(String source, boolean caseSensitive) {
        this.source = source;
        String rest = source;
        boolean domain = false, start = false, end = false;
        if (rest.startsWith("||")) { domain = true; rest = rest.substring(2); }
        else if (rest.startsWith("|")) { start = true; rest = rest.substring(1); }
        if (rest.endsWith("|")) { end = true; rest = rest.substring(0, rest.length() - 1); }
        this.caseSensitive = caseSensitive;
        pattern = (caseSensitive ? rest : rest.toLowerCase(Locale.ROOT)).toCharArray();
        domainAnchor = domain;
        startAnchor = start;
        endAnchor = end;
    }

    /** The longest literal token the pattern bounds on both sides, or null. */
    String token() {
        String best = null;
        int index = 0;
        while (index < pattern.length) {
            if (!DnrEvaluator.isTokenChar(Character.toLowerCase(pattern[index]))) { index++; continue; }
            int start = index;
            while (index < pattern.length && DnrEvaluator.isTokenChar(Character.toLowerCase(pattern[index]))) index++;
            boolean left = start == 0 ? (domainAnchor || startAnchor) : pattern[start - 1] != '*';
            boolean right = index == pattern.length ? endAnchor : pattern[index] != '*';
            if (left && right && index - start >= 2 && (best == null || index - start > best.length())) {
                best = new String(pattern, start, index - start).toLowerCase(Locale.ROOT);
            }
        }
        return best;
    }

    /**
     * A literal run of at least three token characters the pattern holds
     * even where a `*` bounds it, lower-cased: rules without a bounded
     * token are filed by its first three characters.
     */
    String trigram() {
        int index = 0;
        while (index < pattern.length) {
            if (!DnrEvaluator.isTokenChar(Character.toLowerCase(pattern[index]))) { index++; continue; }
            int start = index;
            while (index < pattern.length && DnrEvaluator.isTokenChar(Character.toLowerCase(pattern[index]))) index++;
            if (index - start >= 3) return new String(pattern, start, 3).toLowerCase(Locale.ROOT);
        }
        return null;
    }

    /**
     * The pattern is split at its `*`s into segments of literals and
     * `^`; each segment after the first is found at its leftmost place
     * after the previous one (any later place leaves the rest less room),
     * so a match costs at most the URL's length times the pattern's,
     * never the backtracking a long URL would make of a leading `*`.
     */
    private int[][] segments;

    private int[][] segments() {
        if (segments == null) {
            List<int[]> parts = new ArrayList<>();
            int start = 0;
            for (int index = 0; index <= pattern.length; index++) {
                if (index < pattern.length && pattern[index] != '*') continue;
                parts.add(new int[] { start, index });
                start = index + 1;
            }
            segments = parts.toArray(new int[0][]);
        }
        return segments;
    }

    boolean matches(String url, String lowerUrl) {
        String subject = caseSensitive ? url : lowerUrl;
        int length = subject.length();
        int[][] parts = segments();
        if (domainAnchor) {
            int scheme = subject.indexOf("://");
            if (scheme <= 0) return false;
            int host = scheme + 3;
            int hostEnd = host;
            while (hostEnd < length && "/?#".indexOf(subject.charAt(hostEnd)) < 0) hostEnd++;
            int at = subject.lastIndexOf('@', hostEnd - 1);
            if (at >= host) host = at + 1;
            if (matchFrom(subject, parts, host)) return true;
            for (int index = host; index < hostEnd; index++) {
                if (subject.charAt(index) == '.' && matchFrom(subject, parts, index + 1)) return true;
            }
            return false;
        }
        if (startAnchor) return matchFrom(subject, parts, 0);
        // Unanchored: the first segment at its leftmost place, as any other.
        int found = find(subject, parts[0], 0, parts.length == 1 && endAnchor);
        return found >= 0 && rest(subject, parts, segmentEnd(subject, parts[0], found));
    }

    /** The first segment exactly at `start`, the rest after it. */
    private boolean matchFrom(String subject, int[][] parts, int start) {
        int end = segmentEnd(subject, parts[0], start);
        if (end < 0) return false;
        if (parts.length == 1) return !endAnchor || end == subject.length();
        return rest(subject, parts, end);
    }

    /** Segments 1.. each at its leftmost place from `from`; the last at the end when anchored there. */
    private boolean rest(String subject, int[][] parts, int from) {
        if (parts.length == 1) return !endAnchor || from == subject.length();
        int position = from;
        for (int index = 1; index < parts.length; index++) {
            boolean last = index == parts.length - 1;
            int found = find(subject, parts[index], position, last && endAnchor);
            if (found < 0) return false;
            position = segmentEnd(subject, parts[index], found);
        }
        return true;
    }

    /** Where the segment first matches at or after `from` (ending at the URL's end when `atEnd`); -1 if nowhere. */
    private int find(String subject, int[] part, int from, boolean atEnd) {
        int length = subject.length();
        if (part[0] == part[1]) return atEnd ? length : from;
        char first = pattern[part[0]];
        for (int index = from; index <= length; index++) {
            if (first != '^') {
                index = subject.indexOf(first, index);
                if (index < 0) return -1;
            }
            int end = segmentEnd(subject, part, index);
            if (end >= 0 && (!atEnd || end == length)) return index;
        }
        return -1;
    }

    /** Where the segment ends when it matches at `at`, else -1; `^` also matches the URL's end. */
    private int segmentEnd(String subject, int[] part, int at) {
        int length = subject.length();
        int ui = at;
        for (int pi = part[0]; pi < part[1]; pi++) {
            char c = pattern[pi];
            if (c == '^') {
                if (ui == length) continue;
                if (!DnrEvaluator.isSeparator(subject.charAt(ui))) return -1;
                ui++;
                continue;
            }
            if (ui >= length || subject.charAt(ui) != c) return -1;
            ui++;
        }
        return ui;
    }
}
