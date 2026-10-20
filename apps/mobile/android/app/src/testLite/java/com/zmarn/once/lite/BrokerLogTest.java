package com.zmarn.once.lite;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

/** A release build's logcat names a request's origin, never what the user reads. */
public class BrokerLogTest {
    @Test public void releaseLogsKeepUrlsToTheirOrigin() {
        boolean was = BrokerChannel.verboseLogs;
        try {
            BrokerChannel.verboseLogs = false;
            assertEquals("Request https://news.example/… failed in the broker: x (moz-extension://abc/…)",
                BrokerChannel.forLog("Request https://news.example/2026/private-story?id=7#c failed in the broker: x (moz-extension://abc/js/vapi.js)"));
            BrokerChannel.verboseLogs = true;
            assertEquals("https://news.example/story", BrokerChannel.forLog("https://news.example/story"));
        } finally {
            BrokerChannel.verboseLogs = was;
        }
    }
}
