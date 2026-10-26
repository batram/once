package com.zmarn.once;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class ExtensionCatalogSnapshotTest {
    private static JSONArray catalog() throws Exception {
        return new JSONArray().put(new JSONObject().put("id", "uBlock0@raymondhill.net").put("name", "uBlock Origin")
            .put("version", "1.60").put("enabled", true).put("iconDataUrl", "data:image/png;base64,AAAA"));
    }

    @Test
    public void roundTripsTheCatalogText() throws Exception {
        String encoded = ExtensionCatalogSnapshot.encode(catalog());
        JSONArray decoded = ExtensionCatalogSnapshot.decode(encoded);
        assertEquals(1, decoded.length());
        assertEquals("uBlock Origin", decoded.getJSONObject(0).getString("name"));
        assertEquals("data:image/png;base64,AAAA", decoded.getJSONObject(0).getString("iconDataUrl"));
    }

    @Test
    public void anEmptyCatalogIsAValidSnapshot() {
        assertEquals(0, ExtensionCatalogSnapshot.decode(ExtensionCatalogSnapshot.encode(new JSONArray())).length());
    }

    @Test
    public void rejectsRowsWithoutIdentityAndUnreadableText() throws Exception {
        assertNull(ExtensionCatalogSnapshot.decode(null));
        assertNull(ExtensionCatalogSnapshot.decode("{not json"));
        assertNull(ExtensionCatalogSnapshot.decode("{\"extensions\":[]}"));
        assertNull(ExtensionCatalogSnapshot.decode(new JSONArray().put(new JSONObject().put("name", "Nameless id")).toString()));
        assertNull(ExtensionCatalogSnapshot.decode(new JSONArray().put(new JSONObject().put("id", 7).put("name", "Numeric id")).toString()));
        assertNull(ExtensionCatalogSnapshot.encode(new JSONArray().put("not a row")));
    }
}
