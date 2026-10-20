package com.zmarn.once.lite;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import org.junit.Test;

/** Tier 2 against damaged caches, hostile pushes and Chrome's precedence where the first port diverged. */
public class Tier2RobustnessTest {
    private static DnrEvaluator evaluator(String json) {
        return new DnrEvaluator(Collections.singletonList(DnrEvaluator.group("g", null, Collections.singletonList(DnrEvaluator.compileArray(json)))));
    }

    private static DnrEvaluator.Decision decide(DnrEvaluator evaluator, String url, String type, String initiator) {
        return evaluator.evaluate(new DnrEvaluator.Request(url, type, "GET", initiator, 1, null)).decision;
    }

    private static final String RULES = "[{\"id\":1,\"action\":{\"type\":\"block\"},\"condition\":{\"urlFilter\":\"||ads.example^\"}},"
        + "{\"id\":2,\"action\":{\"type\":\"redirect\",\"redirect\":{\"extensionPath\":\"/noop.js\"}},\"condition\":{\"urlFilter\":\"/lib.js\"}}]";

    @Test public void aDamagedRulesCacheIsRefusedNeverTrusted() throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        DnrRuleCache.write(DnrEvaluator.compileArray(RULES), bytes);
        byte[] good = bytes.toByteArray();
        assertEquals(2, DnrRuleCache.read(new ByteArrayInputStream(good)).rules.size());
        for (int at = 12; at < good.length; at += Math.max(1, good.length / 40)) {
            byte[] damaged = good.clone();
            damaged[at] ^= 0x5a;
            try { DnrRuleCache.read(new ByteArrayInputStream(damaged)); fail("byte " + at + " damaged went unnoticed"); }
            catch (IOException expected) { /* refused */ }
        }
        // A huge count is refused before anything is allocated.
        byte[] huge = good.clone();
        huge[12] = 0x7f;
        try { DnrRuleCache.read(new ByteArrayInputStream(huge)); fail("a huge string table was allocated"); }
        catch (IOException expected) { /* refused */ }
        try { DnrRuleCache.read(new ByteArrayInputStream(java.util.Arrays.copyOf(good, good.length - 3))); fail("a truncated file was read"); }
        catch (IOException expected) { /* refused */ }
    }

    @Test public void deeplyNestedJsonIsRefusedWithoutExhaustingTheStack() {
        StringBuilder deep = new StringBuilder();
        for (int index = 0; index < 100000; index++) deep.append('[');
        try { MiniJson.parse(deep.toString()); fail("parsed"); }
        catch (IllegalArgumentException expected) { assertTrue(expected.getMessage(), expected.getMessage().contains("deep")); }
        assertEquals(1, ((java.util.List<?>) MiniJson.parse("[[[[1]]]]")).size());
    }

    @Test public void precedenceFollowsChrome() {
        String allowAll = "{\"id\":1,\"action\":{\"type\":\"allowAllRequests\"},\"condition\":{\"urlFilter\":\"||a.example^\",\"resourceTypes\":[\"main_frame\"]}}";
        String allow = "{\"id\":2,\"action\":{\"type\":\"allow\"},\"condition\":{\"urlFilter\":\"||a.example^\",\"resourceTypes\":[\"main_frame\"]}}";
        assertEquals(DnrEvaluator.Outcome.ALLOW, decide(evaluator("[" + allowAll + "," + allow + "]"), "https://a.example/", "main_frame", null).outcome);
        assertEquals(DnrEvaluator.Outcome.ALLOW, decide(evaluator("[" + allow + "," + allowAll + "]"), "https://a.example/", "main_frame", null).outcome);
        String block = "{\"id\":9,\"action\":{\"type\":\"block\"},\"condition\":{\"urlFilter\":\"||a.example^\"}}";
        // A higher-priority upgrade of a secure URL, or a redirect to the URL itself, does not apply: the block does.
        String upgrade = "{\"id\":3,\"priority\":2,\"action\":{\"type\":\"upgradeScheme\"},\"condition\":{\"urlFilter\":\"||a.example^\"}}";
        assertEquals(DnrEvaluator.Outcome.BLOCK, decide(evaluator("[" + upgrade + "," + block + "]"), "https://a.example/x.js", "script", "https://b.example/").outcome);
        assertEquals(DnrEvaluator.Outcome.UPGRADE_SCHEME, decide(evaluator("[" + upgrade + "," + block + "]"), "http://a.example/x.js", "script", "https://b.example/").outcome);
        String noop = "{\"id\":4,\"priority\":2,\"action\":{\"type\":\"redirect\",\"redirect\":{\"transform\":{\"query\":\"\"}}},\"condition\":{\"urlFilter\":\"||a.example^\"}}";
        assertEquals(DnrEvaluator.Outcome.BLOCK, decide(evaluator("[" + noop + "," + block + "]"), "https://a.example/x.js", "script", "https://b.example/").outcome);
        assertEquals(DnrEvaluator.Outcome.REDIRECT, decide(evaluator("[" + noop + "," + block + "]"), "https://a.example/x.js?q", "script", "https://b.example/").outcome);
    }

    @Test public void addressesAreTheirOwnSiteAndTransformsSetCredentials() {
        assertTrue(DnrEvaluator.thirdParty("10.0.0.2", "10.0.0.1"));
        assertFalse(DnrEvaluator.thirdParty("a.example.com", "b.example.com"));
        Map<String, Object> transform = new HashMap<>();
        transform.put("username", "");
        transform.put("password", "");
        assertEquals("https://a.example/x?y", DnrEvaluator.transformed("https://u:p@a.example/x?y", transform));
        transform.put("username", "me");
        assertEquals("https://me@a.example/x?y", DnrEvaluator.transformed("https://u:p@a.example/x?y", transform));
    }

    @Test public void regexFiltersStayInRe2AndSeeABoundedUrl() {
        DnrEvaluator.Compiled compiled = DnrEvaluator.compileArray("["
            + "{\"id\":1,\"action\":{\"type\":\"block\"},\"condition\":{\"regexFilter\":\"^https://(?=x)\"}},"
            + "{\"id\":2,\"action\":{\"type\":\"block\"},\"condition\":{\"regexFilter\":\"(a)\\\\1\"}},"
            + "{\"id\":3,\"action\":{\"type\":\"block\"},\"condition\":{\"regexFilter\":\"^https?:\\\\/\\\\/.*\\\\/.*sw[0-9._].*\"}}]");
        assertEquals("lookaround and backreferences are refused", 2, compiled.skipped);
        DnrEvaluator rules = new DnrEvaluator(Collections.singletonList(DnrEvaluator.group("g", null, Collections.singletonList(compiled))));
        StringBuilder url = new StringBuilder("https://x.example/");
        while (url.length() < 64000) url.append("/a");
        long started = System.nanoTime();
        assertEquals(DnrEvaluator.Outcome.NONE, decide(rules, url.toString(), "image", null).outcome);
        assertTrue("bounded", (System.nanoTime() - started) / 1000000 < 200);
        assertEquals(DnrEvaluator.Outcome.BLOCK, decide(rules, "https://x.example/a/sw1.js", "script", null).outcome);
    }

    @Test public void theRedirectFetchStaysOffThisDeviceAndItsNetwork() {
        for (String host : new String[] { "127.0.0.1", "10.1.2.3", "192.168.0.1", "172.16.0.9", "169.254.1.1", "[::1]", "[fd00::1]", "localhost", "a.localhost", "0.0.0.0" }) {
            assertTrue(host, LiteTier2.isPrivateHost(host));
        }
        assertFalse(LiteTier2.isPrivateHost("93.184.216.34"));
        assertFalse(LiteTier2.isPrivateHost("[2606:4700::1111]"));
    }

    @Test public void resourceTypesFromWhatTheCallbackCarries() {
        Map<String, String> none = new HashMap<>();
        assertEquals("script", LiteTier2.resourceType(false, none, "https://www.googletagmanager.com/gtag/js?id=G-1"));
        Map<String, String> xhr = new HashMap<>();
        xhr.put("X-Requested-With", "XMLHttpRequest");
        assertEquals("xmlhttprequest", LiteTier2.resourceType(false, xhr, "https://api.example/data"));
        Map<String, String> ping = new HashMap<>();
        ping.put("Ping-To", "https://site.example/");
        assertEquals("ping", LiteTier2.resourceType(false, ping, "https://t.example/collect"));
        assertEquals("other", LiteTier2.resourceType(false, none, "https://api.example/data"));
    }

    @Test public void requestsAreJudgedByTheCommittedDocumentNotOneThatNeverCommits() {
        DnrEvaluator rules = evaluator("[{\"id\":1,\"action\":{\"type\":\"allowAllRequests\"},\"condition\":{\"urlFilter\":\"||trusted.example^\",\"resourceTypes\":[\"main_frame\"]}}]");
        LiteTier2.Tab tab = new LiteTier2.Tab(1);
        LiteTier2.commit(tab, "https://attacker.example/", rules);
        assertTrue(tab.committed.frameAllow.isEmpty());
        // The page starts a navigation to a trusted site and stops it (or it answers 204): nothing commits.
        tab.pending = new LiteTier2.Document("https://trusted.example/", Collections.singletonMap("g", 1));
        assertEquals("the attacker's own requests", "https://attacker.example/", LiteTier2.documentOf(tab, "https://attacker.example/").url);
        assertEquals("requests without a Referer", "https://attacker.example/", LiteTier2.documentOf(tab, null).url);
        assertEquals("the new document's first requests", "https://trusted.example/", LiteTier2.documentOf(tab, "https://trusted.example/").url);
        // It commits: from now on its rules apply; a same-document change keeps them.
        LiteTier2.commit(tab, "https://trusted.example/#top", rules);
        assertEquals(Integer.valueOf(1), tab.committed.frameAllow.get("g"));
        LiteTier2.commit(tab, "https://trusted.example/page2", rules);
        assertEquals(Integer.valueOf(1), tab.committed.frameAllow.get("g"));
        // A document from the back/forward cache made no request: its rules are evaluated at commit.
        LiteTier2.commit(tab, "https://attacker.example/", rules);
        assertTrue(tab.committed.frameAllow.isEmpty());
        LiteTier2.commit(tab, "https://trusted.example/", rules);
        assertEquals(Integer.valueOf(1), tab.committed.frameAllow.get("g"));
    }
}
