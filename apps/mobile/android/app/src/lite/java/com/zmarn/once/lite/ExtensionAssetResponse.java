package com.zmarn.once.lite;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Native body transport after broker authorization; never forwards host file paths to CDP. */
final class ExtensionAssetResponse {
    private ExtensionAssetResponse() {}

    static JSONObject create(JSONObject command, byte[] body) throws JSONException {
        JSONArray headers = command.getJSONArray("responseHeaders");
        int status = 200;
        if (body == null) {
            status = 404;
            body = "No such extension file".getBytes(StandardCharsets.UTF_8);
            // Match the protocol's missing-file response while retaining the caller's CORS grant.
            JSONArray missing = new JSONArray();
            for (int index = 0; index < headers.length(); index++) {
                JSONObject header = headers.getJSONObject(index);
                if (header.getString("name").toLowerCase(java.util.Locale.ROOT).startsWith("access-control-")) missing.put(header);
            }
            missing.put(new JSONObject().put("name", "content-type").put("value", "text/plain; charset=utf-8"));
            headers = missing;
        }
        return new JSONObject().put("requestId", command.getString("requestId"))
            .put("responseCode", status).put("responseHeaders", headers)
            .put("body", Base64.getEncoder().encodeToString(body));
    }
}
