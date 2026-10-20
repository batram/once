package com.zmarn.once.lite;

import static org.junit.Assert.*;
import java.util.Base64;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class ExtensionAssetResponseTest {
    private JSONObject command() throws Exception {
        return new JSONObject().put("requestId", "paused-1").put("directory", "private/path").put("path", "icon.png")
            .put("oncePause", 17).put("responseHeaders", new JSONArray()
                .put(new JSONObject().put("name", "content-type").put("value", "image/png"))
                .put(new JSONObject().put("name", "content-security-policy").put("value", "script-src 'self'"))
                .put(new JSONObject().put("name", "Access-Control-Allow-Origin").put("value", "https://extension.localhost")));
    }

    @Test public void binaryBytesAndSecurityHeadersSurviveWithoutForwardingFilePaths() throws Exception {
        byte[] body = new byte[] { 0, 1, -1, -128, 64, 10 };
        JSONObject input = command();
        JSONObject result = ExtensionAssetResponse.create(input, body);
        assertArrayEquals(body, Base64.getDecoder().decode(result.getString("body")));
        assertEquals(200, result.getInt("responseCode"));
        assertEquals("paused-1", result.getString("requestId"));
        assertEquals(input.getJSONArray("responseHeaders").toString(), result.getJSONArray("responseHeaders").toString());
        assertEquals(4, result.length());
        assertFalse(result.has("directory"));
        assertFalse(result.has("path"));
        assertFalse(result.has("oncePause"));
    }

    @Test public void missingFilesReturn404AndKeepOnlyCorsGrant() throws Exception {
        JSONObject result = ExtensionAssetResponse.create(command(), null);
        assertEquals(404, result.getInt("responseCode"));
        assertEquals(2, result.getJSONArray("responseHeaders").length());
        assertEquals("Access-Control-Allow-Origin", result.getJSONArray("responseHeaders").getJSONObject(0).getString("name"));
        assertEquals("text/plain; charset=utf-8", result.getJSONArray("responseHeaders").getJSONObject(1).getString("value"));
        assertEquals("No such extension file", new String(Base64.getDecoder().decode(result.getString("body")), java.nio.charset.StandardCharsets.UTF_8));
    }
}
