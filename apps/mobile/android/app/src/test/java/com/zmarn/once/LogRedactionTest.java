package com.zmarn.once;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class LogRedactionTest {
    @Test
    public void redactsAuthorizationHeaderInPluginCall() {
        String call = "methodData: {\"url\":\"https:\\/\\/couch.example\\/once\\/\",\"headers\":{\"authorization\":\"Basic bW9lcDpiMDQ4OGM3MzQy\",\"accept\":\"application\\/json\"}}";
        String result = LogRedaction.redact(call);
        assertFalse(result, result.contains("bW9lcDpiMDQ4OGM3MzQy"));
        assertTrue(result, result.contains("\"authorization\":\"[redacted]\""));
        assertTrue(result, result.contains("\"accept\":\"application\\/json\""));
    }

    @Test
    public void redactsEscapedJsonInsideAString() {
        String result = LogRedaction.redact("{\"data\":\"{\\\"password\\\":\\\"hunter22\\\",\\\"name\\\":\\\"x\\\"}\"}");
        assertFalse(result, result.contains("hunter22"));
        assertTrue(result, result.contains("\\\"name\\\":\\\"x\\\""));
    }

    @Test
    public void redactsUrlCredentialsAndQueryTokens() {
        assertEquals("https://[redacted]@couch.example/db?access_token=[redacted]&since=12",
            LogRedaction.redact("https://user:pass@couch.example/db?access_token=abc123&since=12"));
    }

    @Test
    public void redactsBareAuthorizationSchemes() {
        assertEquals("sent Bearer [redacted] ok", LogRedaction.redact("sent Bearer eyJhbGciOiJIUzI1NiJ9.e30.x ok"));
        assertEquals("Basic information about tokens", LogRedaction.redact("Basic information about tokens"));
    }

    @Test
    public void leavesOrdinaryTextAndTruncatesLongMessages() {
        assertEquals("mobile database changed", LogRedaction.redact("mobile database changed"));
        String result = LogRedaction.redact("a".repeat(LogRedaction.MAX_LENGTH + 10));
        assertTrue(result.startsWith("a".repeat(LogRedaction.MAX_LENGTH) + "…"));
        assertTrue(result.endsWith("(10 more characters)"));
    }
}
