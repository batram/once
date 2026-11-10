package com.zmarn.once.lite;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

public class BrokerEnvelopeTest {
    @Test public void aPageDocumentIsSplicedIntoItsEventUnparsed() throws Exception {
        String document = "{\"type\":\"invoke\",\"args\":[{\"cache/a\":\"}]\\\"\\\\\"}],\"n\":{\"deep\":[1,2]}}";
        assertTrue(BrokerChannel.oneObject(document));
        JSONObject envelope = new JSONObject(BrokerChannel.envelope("page.message",
            new JSONObject().put("pageId", "p\"1").put("frameId", 3), "message", document));
        assertEquals("event", envelope.getString("type"));
        assertEquals("page.message", envelope.getString("event"));
        JSONObject params = envelope.getJSONObject("params");
        assertEquals("p\"1", params.getString("pageId"));
        assertEquals(3, params.getInt("frameId"));
        assertEquals(new JSONObject(document).toString(), params.getJSONObject("message").toString());
    }

    @Test public void textThatWouldLeaveItsPlaceInTheEnvelopeIsRefused() {
        // Each of these would close the params early, or add members beside the message.
        assertFalse(BrokerChannel.oneObject("{\"a\":1},\"pageId\":\"other\""));
        assertFalse(BrokerChannel.oneObject("{\"a\":1}},\"event\":\"tab.removed\",\"params\":{\"x\":{\"y\":1"));
        assertFalse(BrokerChannel.oneObject("{\"a\":1}{\"b\":2}"));
        assertFalse(BrokerChannel.oneObject("1,\"pageId\":\"other\""));
        assertFalse(BrokerChannel.oneObject("[{\"a\":1}]"));
        assertFalse(BrokerChannel.oneObject("{\"a\":\"unterminated}"));
        assertFalse(BrokerChannel.oneObject("{\"a\":{\"b\":1}"));
        assertFalse(BrokerChannel.oneObject(""));
        // A brace inside a string closes nothing.
        assertTrue(BrokerChannel.oneObject("{\"a\":\"}\\\"}\",\"b\":[\"]\"]}"));
    }
}
