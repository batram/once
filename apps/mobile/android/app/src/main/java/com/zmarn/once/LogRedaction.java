package com.zmarn.once;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Strips credentials from text bound for logcat, which any USB debugger or
 * bug report can read: sync requests carry a Basic authorization header, and
 * URLs may carry a password or token.
 */
final class LogRedaction {
    static final String REDACTED = "[redacted]";
    static final int MAX_LENGTH = 4000;

    private static final String SECRET_NAMES =
        "authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[_-]?key|password|passwd|secret"
        + "|token|access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?id|client[_-]?secret";
    // "name":"value" and name: value, as JSON or as escaped JSON inside a string.
    private static final Pattern FIELD = Pattern.compile(
        "(?i)((?:\\\\?\")?(?:" + SECRET_NAMES + ")(?:\\\\?\")?\\s*[:=]\\s*)(\\\\?\"(?:[^\"\\\\]|\\\\(?!\"))*\\\\?\"|[^\\s,;}&\"]+)");
    // A credential has a digit or base64 padding; prose such as "Basic information" does not.
    private static final Pattern SCHEME = Pattern.compile("(?i)\\b(Basic|Bearer|Digest)\\s+(?=[A-Za-z0-9._~+/=-]*[0-9+/=])[A-Za-z0-9._~+/=-]{6,}");
    private static final Pattern USERINFO = Pattern.compile("(?i)\\b([a-z][a-z0-9+.-]*://)[^/\\s@\"]+@");

    private LogRedaction() {}

    static String redact(String text) {
        if (text == null) return null;
        String result = USERINFO.matcher(text).replaceAll("$1" + REDACTED + "@");
        result = SCHEME.matcher(result).replaceAll("$1 " + REDACTED);
        Matcher field = FIELD.matcher(result);
        StringBuffer out = new StringBuffer();
        while (field.find()) {
            String value = field.group(2);
            String quote = value.startsWith("\\\"") ? "\\\"" : value.startsWith("\"") ? "\"" : "";
            field.appendReplacement(out, Matcher.quoteReplacement(field.group(1) + quote + REDACTED + quote));
        }
        field.appendTail(out);
        result = out.toString();
        if (result.length() > MAX_LENGTH) {
            result = result.substring(0, MAX_LENGTH) + "… (" + (result.length() - MAX_LENGTH) + " more characters)";
        }
        return result;
    }
}
