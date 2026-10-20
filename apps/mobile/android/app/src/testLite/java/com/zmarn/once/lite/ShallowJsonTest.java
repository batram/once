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
}
