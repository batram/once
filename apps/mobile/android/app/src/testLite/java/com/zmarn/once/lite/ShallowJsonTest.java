package com.zmarn.once.lite;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;

import java.io.File;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import org.junit.Test;

/** A split store document keeps keys of any length, as file systems take only short names. */
public class ShallowJsonTest {
    @Test public void longKeysSplitPatchAndJoinBack() throws Exception {
        File directory = Files.createTempDirectory("shallow").toFile();
        StringBuilder longKey = new StringBuilder("cache:");
        while (longKey.length() < 600) longKey.append("https://example.test/a/very/long/path?");
        File document = new File(directory, "storage.json");
        Files.write(document.toPath(), ("{\"short\":1," + org.json.JSONObject.quote(longKey.toString()) + ":{\"v\":[1,2]}}").getBytes(StandardCharsets.UTF_8));
        File split = new File(directory, "storage.json.d");
        ShallowJson.split(document, split);
        for (File file : split.listFiles()) assertFalse(file.getName(), file.getName().length() > 255);
        // A patch replaces the long key's value and adds another long one.
        String other = longKey + "#2";
        for (String key : new String[] { longKey.toString(), other }) {
            File target = ShallowJson.keyFile(split, key);
            ShallowJson.writeAtomically(target, "\"" + key.length() + "\"");
            ShallowJson.recordKey(target, key);
        }
        StringWriter joined = new StringWriter();
        ShallowJson.join(split, joined);
        org.json.JSONObject read = new org.json.JSONObject(joined.toString());
        assertEquals(3, read.length());
        assertEquals(1, read.getInt("short"));
        assertEquals(String.valueOf(longKey.length()), read.getString(longKey.toString()));
        ShallowJson.deleteKey(split, other);
        joined = new StringWriter();
        ShallowJson.join(split, joined);
        assertEquals(2, new org.json.JSONObject(joined.toString()).length());
        LiteFiles.delete(directory);
    }
    @Test public void keyedReadsMatchLegacyAndSplitWithoutOpeningUnrelatedValues() throws Exception {
        File directory = Files.createTempDirectory("shallow-selected").toFile();
        try {
            String longKey = new String(new char[600]).replace("\0", "x");
            org.json.JSONObject data = new org.json.JSONObject().put("small", 1).put("", "empty key")
                .put(longKey, new org.json.JSONArray("[1,{\"nested\":true}]"))
                .put("large", new String(new char[2000000]).replace("\0", "z"));
            File document = new File(directory, "storage.json");
            Files.write(document.toPath(), data.toString().getBytes(StandardCharsets.UTF_8));
            java.util.Set<String> keys = new java.util.LinkedHashSet<>(java.util.Arrays.asList("small", "", longKey, "absent"));
            StringWriter legacy = new StringWriter();
            ShallowJson.select(document, legacy, keys);
            org.json.JSONObject selected = new org.json.JSONObject(legacy.toString());
            assertEquals(3, selected.length());
            assertEquals("empty key", selected.getString(""));
            assertEquals(1, selected.getInt("small"));
            assertEquals(2, selected.getJSONArray(longKey).length());
            File split = new File(directory, "split");
            ShallowJson.split(document, split);
            // A keyed read must not touch or parse this unrelated cache entry.
            Files.write(ShallowJson.keyFile(split, "large").toPath(), "invalid JSON".getBytes(StandardCharsets.UTF_8));
            StringWriter joined = new StringWriter();
            ShallowJson.join(split, joined, keys);
            org.json.JSONObject splitSelected = new org.json.JSONObject(joined.toString());
            assertEquals(selected.toString(), splitSelected.toString());
            joined = new StringWriter();
            ShallowJson.join(split, joined, java.util.Collections.emptySet());
            assertEquals("{}", joined.toString());
        } finally { LiteFiles.delete(directory); }
    }
}
