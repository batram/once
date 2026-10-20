package com.zmarn.once.lite;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.Test;

/** Tier 2's DNR evaluator: urlFilter syntax, conditions, precedence, redirects, groups. */
public class DnrEvaluatorTest {
    private static DnrEvaluator evaluator(String rulesJson) { return evaluator(rulesJson, null); }

    private static DnrEvaluator evaluator(String rulesJson, String secondGroup) {
        List<DnrEvaluator.Group> groups = new ArrayList<>();
        groups.add(DnrEvaluator.group("one", "asset:one", Collections.singletonList(DnrEvaluator.compileArray(rulesJson))));
        if (secondGroup != null) groups.add(DnrEvaluator.group("two", null, Collections.singletonList(DnrEvaluator.compileArray(secondGroup))));
        return new DnrEvaluator(groups);
    }

    private static DnrEvaluator.Decision decide(DnrEvaluator evaluator, String url, String type, String initiator) {
        return evaluator.evaluate(new DnrEvaluator.Request(url, type, "GET", initiator, 1, null)).decision;
    }

    private static String block(int id, String urlFilter) {
        return "{\"id\":" + id + ",\"action\":{\"type\":\"block\"},\"condition\":{\"urlFilter\":\"" + urlFilter + "\"}}";
    }

    private static DnrEvaluator.Outcome outcome(DnrEvaluator evaluator, String url) {
        return decide(evaluator, url, "image", "https://page.example/").outcome;
    }

    @Test
    public void domainAnchorMatchesTheHostAndItsSubdomainsOnly() {
        DnrEvaluator rules = evaluator("[" + block(1, "||ads.example^") + "]");
        assertEquals(DnrEvaluator.Outcome.BLOCK, outcome(rules, "https://ads.example/banner.png"));
        assertEquals(DnrEvaluator.Outcome.BLOCK, outcome(rules, "https://cdn.ads.example/banner.png"));
        assertEquals(DnrEvaluator.Outcome.BLOCK, outcome(rules, "http://ads.example"));
        assertEquals(DnrEvaluator.Outcome.BLOCK, outcome(rules, "https://ads.example:8443/x"));
        assertEquals(DnrEvaluator.Outcome.NONE, outcome(rules, "https://badads.example/banner.png"));
        assertEquals(DnrEvaluator.Outcome.NONE, outcome(rules, "https://ads.example.com/banner.png"));
        assertEquals(DnrEvaluator.Outcome.NONE, outcome(rules, "https://page.example/?u=ads.example"));
    }

    @Test
    public void startAndEndAnchorsPinTheEnds() {
        DnrEvaluator rules = evaluator("[" + block(1, "|https://cdn.example/") + "," + block(2, "/ad.png|") + "]");
        assertEquals(DnrEvaluator.Outcome.BLOCK, outcome(rules, "https://cdn.example/lib.js"));
        assertEquals(DnrEvaluator.Outcome.NONE, outcome(rules, "https://www.example/?r=https://cdn.example/"));
        assertEquals(DnrEvaluator.Outcome.BLOCK, outcome(rules, "https://x.example/img/ad.png"));
        assertEquals(DnrEvaluator.Outcome.NONE, outcome(rules, "https://x.example/img/ad.png?v=2"));
    }

    @Test
    public void separatorAndWildcardFollowChrome() {
        DnrEvaluator rules = evaluator("[" + block(1, "/banner^") + "," + block(2, "||tracker.example/*/pixel*.gif") + "]");
        assertEquals(DnrEvaluator.Outcome.BLOCK, outcome(rules, "https://x.example/banner/1"));
        assertEquals(DnrEvaluator.Outcome.BLOCK, outcome(rules, "https://x.example/banner?x"));
        assertEquals(DnrEvaluator.Outcome.BLOCK, outcome(rules, "https://x.example/banner"));
        // `^` is not a letter, digit or one of `_ - . %`.
        assertEquals(DnrEvaluator.Outcome.NONE, outcome(rules, "https://x.example/banner.png"));
        assertEquals(DnrEvaluator.Outcome.NONE, outcome(rules, "https://x.example/banners"));
        assertEquals(DnrEvaluator.Outcome.BLOCK, outcome(rules, "https://tracker.example/a/b/pixel-1.gif"));
        assertEquals(DnrEvaluator.Outcome.NONE, outcome(rules, "https://tracker.example/pixel-1.gif"));
    }

    @Test
    public void matchingIgnoresCaseUnlessAsked() {
        DnrEvaluator rules = evaluator("[" + block(1, "/AdFrame/") + ","
            + "{\"id\":2,\"action\":{\"type\":\"block\"},\"condition\":{\"urlFilter\":\"/Exact/\",\"isUrlFilterCaseSensitive\":true}}]");
        assertEquals(DnrEvaluator.Outcome.BLOCK, outcome(rules, "https://x.example/adframe/1"));
        assertEquals(DnrEvaluator.Outcome.BLOCK, outcome(rules, "https://x.example/Exact/1"));
        assertEquals(DnrEvaluator.Outcome.NONE, outcome(rules, "https://x.example/exact/1"));
    }

    @Test
    public void initiatorAndRequestDomainsWithExclusions() {
        DnrEvaluator rules = evaluator("[{\"id\":1,\"action\":{\"type\":\"block\"},\"condition\":{\"urlFilter\":\"/ad.js\","
            + "\"initiatorDomains\":[\"news.example\"],\"excludedInitiatorDomains\":[\"ok.news.example\"]}},"
            + "{\"id\":2,\"action\":{\"type\":\"block\"},\"condition\":{\"requestDomains\":[\"cdn.example\"],\"excludedRequestDomains\":[\"safe.cdn.example\"]}},"
            + "{\"id\":3,\"action\":{\"type\":\"block\"},\"condition\":{\"urlFilter\":\"/legacy\",\"domains\":[\"old.example\"]}}]");
        assertEquals(DnrEvaluator.Outcome.BLOCK, decide(rules, "https://s.example/ad.js", "script", "https://www.news.example/a").outcome);
        assertEquals(DnrEvaluator.Outcome.NONE, decide(rules, "https://s.example/ad.js", "script", "https://ok.news.example/a").outcome);
        assertEquals(DnrEvaluator.Outcome.NONE, decide(rules, "https://s.example/ad.js", "script", "https://other.example/").outcome);
        // No initiator: no initiator list matches.
        assertEquals(DnrEvaluator.Outcome.NONE, decide(rules, "https://s.example/ad.js", "script", null).outcome);
        assertEquals(DnrEvaluator.Outcome.BLOCK, decide(rules, "https://img.cdn.example/x", "image", "https://a.example/").outcome);
        assertEquals(DnrEvaluator.Outcome.NONE, decide(rules, "https://safe.cdn.example/x", "image", "https://a.example/").outcome);
        assertEquals(DnrEvaluator.Outcome.BLOCK, decide(rules, "https://s.example/legacy", "image", "https://old.example/").outcome);
    }

    @Test
    public void resourceTypesAndTheMainFrameDefault() {
        DnrEvaluator rules = evaluator("[{\"id\":1,\"action\":{\"type\":\"block\"},\"condition\":{\"urlFilter\":\"/img/\",\"resourceTypes\":[\"image\"]}},"
            + "{\"id\":2,\"action\":{\"type\":\"block\"},\"condition\":{\"urlFilter\":\"/any/\",\"excludedResourceTypes\":[\"script\"]}},"
            + "{\"id\":3,\"action\":{\"type\":\"block\"},\"condition\":{\"urlFilter\":\"||doc.example^\"}},"
            + "{\"id\":4,\"action\":{\"type\":\"block\"},\"condition\":{\"urlFilter\":\"||doc.example^\",\"resourceTypes\":[\"main_frame\"],\"requestMethods\":[\"post\"]}}]");
        assertEquals(DnrEvaluator.Outcome.BLOCK, decide(rules, "https://x.example/img/1", "image", "https://p.example/").outcome);
        assertEquals(DnrEvaluator.Outcome.NONE, decide(rules, "https://x.example/img/1", "script", "https://p.example/").outcome);
        assertEquals(DnrEvaluator.Outcome.NONE, decide(rules, "https://x.example/any/1", "script", "https://p.example/").outcome);
        assertEquals(DnrEvaluator.Outcome.BLOCK, decide(rules, "https://x.example/any/1", "main_frame", null).outcome);
        // Without types a rule leaves top-level documents alone ...
        assertEquals(DnrEvaluator.Outcome.NONE, decide(rules, "https://doc.example/", "main_frame", null).outcome);
        assertEquals(DnrEvaluator.Outcome.BLOCK, decide(rules, "https://doc.example/", "sub_frame", "https://p.example/").outcome);
        // ... and a method list restricts the rule that names them.
        DnrEvaluator.Result post = rules.evaluate(new DnrEvaluator.Request("https://doc.example/", "main_frame", "POST", null, 1, null));
        assertEquals(Integer.valueOf(4), post.decision.ruleId);
    }

    @Test
    public void allowBeatsBlockAtEqualPriorityAndHigherPriorityWins() {
        DnrEvaluator rules = evaluator("[" + block(1, "||ads.example^") + ","
            + "{\"id\":2,\"priority\":1,\"action\":{\"type\":\"allow\"},\"condition\":{\"urlFilter\":\"||ads.example/ok^\"}},"
            + "{\"id\":3,\"priority\":5,\"action\":{\"type\":\"block\"},\"condition\":{\"urlFilter\":\"||ads.example/ok/bad\"}},"
            + "{\"id\":4,\"priority\":5,\"action\":{\"type\":\"redirect\",\"redirect\":{\"url\":\"https://x.example/r\"}},\"condition\":{\"urlFilter\":\"||ads.example/ok/bad\"}}]");
        assertEquals(DnrEvaluator.Outcome.BLOCK, outcome(rules, "https://ads.example/a"));
        DnrEvaluator.Decision allowed = decide(rules, "https://ads.example/ok/1", "image", "https://p.example/");
        assertEquals(DnrEvaluator.Outcome.ALLOW, allowed.outcome);
        assertEquals(Integer.valueOf(2), allowed.ruleId);
        // Priority 5 beats the allow; at 5, block beats redirect.
        assertEquals(Integer.valueOf(3), decide(rules, "https://ads.example/ok/bad", "image", "https://p.example/").ruleId);
    }

    @Test
    public void aBlockFromAnyGroupWinsOverAnotherGroupsAllow() {
        DnrEvaluator rules = evaluator("[{\"id\":1,\"priority\":9,\"action\":{\"type\":\"allow\"},\"condition\":{\"urlFilter\":\"/x.png\"}}]",
            "[" + block(1, "/x.png") + "]");
        DnrEvaluator.Decision decision = decide(rules, "https://a.example/x.png", "image", "https://p.example/");
        assertEquals(DnrEvaluator.Outcome.BLOCK, decision.outcome);
        assertEquals("two", decision.group);
    }

    @Test
    public void redirectsToAWebAccessibleResourceAndOtherTargets() {
        DnrEvaluator rules = evaluator("[{\"id\":1,\"priority\":11,\"action\":{\"type\":\"redirect\",\"redirect\":{\"extensionPath\":\"/web_accessible_resources/noop.js\"}},"
            + "\"condition\":{\"urlFilter\":\"||ads.example/lib.js\",\"resourceTypes\":[\"script\"]}},"
            + "{\"id\":2,\"action\":{\"type\":\"redirect\",\"redirect\":{\"regexSubstitution\":\"https://\\\\1.example/clean\"}},"
            + "\"condition\":{\"regexFilter\":\"^https://(\\\\w+)\\\\.track\\\\.example/.*\"}},"
            + "{\"id\":3,\"action\":{\"type\":\"redirect\",\"redirect\":{\"transform\":{\"scheme\":\"https\",\"queryTransform\":{\"removeParams\":[\"utm_source\"]}}}},"
            + "\"condition\":{\"urlFilter\":\"||shop.example/item\"}},"
            + "{\"id\":4,\"action\":{\"type\":\"upgradeScheme\"},\"condition\":{\"urlFilter\":\"||plain.example^\"}}]");
        DnrEvaluator.Decision noop = decide(rules, "https://ads.example/lib.js?v=1", "script", "https://p.example/");
        assertEquals(DnrEvaluator.Outcome.REDIRECT, noop.outcome);
        assertEquals("/web_accessible_resources/noop.js", noop.extensionPath);
        assertEquals("one", noop.group);
        assertNull(noop.redirectUrl);
        assertEquals("https://www.example/clean", decide(rules, "https://www.track.example/p?q", "image", "https://p.example/").redirectUrl);
        assertEquals("https://shop.example/item?id=3", decide(rules, "http://shop.example/item?utm_source=x&id=3", "xmlhttprequest", "https://p.example/").redirectUrl);
        DnrEvaluator.Decision upgrade = decide(rules, "http://plain.example/a", "image", "https://p.example/");
        assertEquals(DnrEvaluator.Outcome.UPGRADE_SCHEME, upgrade.outcome);
        assertEquals("https://plain.example/a", upgrade.redirectUrl);
        assertEquals(DnrEvaluator.Outcome.NONE, decide(rules, "https://plain.example/a", "image", "https://p.example/").outcome);
    }

    @Test
    public void allowAllRequestsCoversTheDocumentsSubresources() {
        DnrEvaluator rules = evaluator("[" + block(1, "/ad.png") + ","
            + "{\"id\":2,\"priority\":2,\"action\":{\"type\":\"allowAllRequests\"},\"condition\":{\"urlFilter\":\"||trusted.example^\",\"resourceTypes\":[\"main_frame\"]}},"
            + "{\"id\":3,\"priority\":3,\"action\":{\"type\":\"block\"},\"condition\":{\"urlFilter\":\"/worse.png\"}}]");
        DnrEvaluator.Result document = rules.evaluate(new DnrEvaluator.Request("https://trusted.example/", "main_frame", "GET", null, 1, null));
        assertEquals(DnrEvaluator.Outcome.ALLOW_ALL_REQUESTS, document.decision.outcome);
        assertEquals(Integer.valueOf(2), document.allowAllRequests.get("one"));
        Map<String, Integer> frame = new HashMap<>(document.allowAllRequests);
        assertEquals(DnrEvaluator.Outcome.ALLOW, rules.evaluate(new DnrEvaluator.Request("https://cdn.example/ad.png", "image", "GET", "https://trusted.example/", 1, frame)).decision.outcome);
        assertEquals(DnrEvaluator.Outcome.BLOCK, rules.evaluate(new DnrEvaluator.Request("https://cdn.example/worse.png", "image", "GET", "https://trusted.example/", 1, frame)).decision.outcome);
    }

    @Test
    public void thirdPartyAndTabConditions() {
        DnrEvaluator rules = evaluator("[{\"id\":1,\"action\":{\"type\":\"block\"},\"condition\":{\"urlFilter\":\"/p.gif\",\"domainType\":\"thirdParty\"}},"
            + "{\"id\":2,\"action\":{\"type\":\"block\"},\"condition\":{\"urlFilter\":\"/t.gif\",\"tabIds\":[7]}}]");
        assertEquals(DnrEvaluator.Outcome.BLOCK, decide(rules, "https://cdn.other.example/p.gif", "image", "https://www.site.example/").outcome);
        assertEquals(DnrEvaluator.Outcome.NONE, decide(rules, "https://img.site.example/p.gif", "image", "https://www.site.example/").outcome);
        assertEquals(DnrEvaluator.Outcome.NONE, decide(rules, "https://a.example/t.gif", "image", "https://p.example/").outcome);
        assertEquals(DnrEvaluator.Outcome.BLOCK, rules.evaluate(new DnrEvaluator.Request("https://a.example/t.gif", "image", "GET", "https://p.example/", 7, null)).decision.outcome);
    }

    @Test
    public void unsupportedRulesAreSkippedNotFatal() {
        DnrEvaluator.Compiled compiled = DnrEvaluator.compileArray("[" + block(1, "/ok") + ","
            + "{\"id\":2,\"action\":{\"type\":\"modifyHeaders\",\"requestHeaders\":[]},\"condition\":{}},"
            + "{\"id\":3,\"action\":{\"type\":\"block\"},\"condition\":{\"regexFilter\":\"(unclosed\"}},"
            + "{\"id\":4,\"action\":{\"type\":\"block\"},\"condition\":{\"resourceTypes\":[\"nonsense\"]}}]");
        assertEquals(1, compiled.rules.size());
        assertEquals(3, compiled.skipped);
    }

    @Test
    public void tokensIndexTheRulesAPatternBounds() {
        assertEquals("example", new DnrUrlFilter("||ads.example^", false).token());
        assertEquals("pagead2", new DnrUrlFilter("||pagead2.*/x", false).token());
        assertNull(new DnrUrlFilter("*ad*", false).token());
        assertEquals("banner", new DnrUrlFilter("/banner^", false).token());
        assertTrue(DnrEvaluator.tokens("https://ads.example/banner.png?id=1").containsAll(Arrays.asList("https", "ads", "example", "banner", "png", "id")));
    }

    @Test
    public void miniJsonReadsTheShapesRulesUse() {
        Object parsed = MiniJson.parse("{\"a\":[1,2.5,true,false,null,\"x\\\"y\\u0041\"],\"b\":{}}");
        assertEquals("{a=[1, 2.5, true, false, null, x\"yA], b={}}", String.valueOf(parsed));
    }

    @Test
    public void theBinaryCacheKeepsEveryDecision() throws Exception {
        String json = "[" + block(1, "||ads.example^") + ","
            + "{\"id\":2,\"priority\":3,\"action\":{\"type\":\"allow\"},\"condition\":{\"urlFilter\":\"/OK/\",\"isUrlFilterCaseSensitive\":true,\"initiatorDomains\":[\"b.example\",\"a.example\"],\"requestMethods\":[\"get\"]}},"
            + "{\"id\":3,\"action\":{\"type\":\"redirect\",\"redirect\":{\"transform\":{\"scheme\":\"https\",\"queryTransform\":{\"removeParams\":[\"x\"]}}}},\"condition\":{\"regexFilter\":\"^http://t\\\\.example/\",\"resourceTypes\":[\"image\"],\"tabIds\":[3]}},"
            + "{\"id\":4,\"action\":{\"type\":\"redirect\",\"redirect\":{\"extensionPath\":\"/war/noop.js\"}},\"condition\":{\"urlFilter\":\"/lib.js\",\"domainType\":\"thirdParty\"}}]";
        DnrEvaluator.Compiled original = DnrEvaluator.compileArray(json);
        java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream();
        DnrRuleCache.write(original, bytes);
        DnrEvaluator.Compiled read = DnrRuleCache.read(new java.io.ByteArrayInputStream(bytes.toByteArray()));
        assertEquals(original.rules.size(), read.rules.size());
        DnrEvaluator before = new DnrEvaluator(Collections.singletonList(DnrEvaluator.group("g", "d", Collections.singletonList(original))));
        DnrEvaluator after = new DnrEvaluator(Collections.singletonList(DnrEvaluator.group("g", "d", Collections.singletonList(read))));
        String[][] requests = {
            { "https://ads.example/x", "image", "https://p.example/" },
            { "https://ads.example/OK/x", "image", "https://www.a.example/" },
            { "https://ads.example/ok/x", "image", "https://www.a.example/" },
            { "http://t.example/p?x=1&y=2", "image", "https://p.example/" },
            { "https://cdn.example/lib.js", "script", "https://p.example/" },
            { "https://p.example/lib.js", "script", "https://p.example/" }
        };
        for (String[] request : requests) {
            for (int tab : new int[] { 1, 3 }) {
                DnrEvaluator.Request details = new DnrEvaluator.Request(request[0], request[1], "GET", request[2], tab, null);
                assertEquals(request[0] + " tab " + tab, before.evaluate(details).decision.toString(), after.evaluate(details).decision.toString());
            }
        }
        assertEquals("https://t.example/p?y=2", after.evaluate(new DnrEvaluator.Request("http://t.example/p?x=1&y=2", "image", "GET", null, 3, null)).decision.redirectUrl);
    }

    /** uBO Lite's shipped default rulesets compile and block what they name. */
    @Test
    public void uboLiteDefaultRulesetsCompile() throws Exception {
        File base = new File("../../../../vendor/extensions/ublock-origin-lite/rulesets");
        if (!base.isDirectory()) base = new File(System.getProperty("user.dir"), "../../../../vendor/extensions/ublock-origin-lite/rulesets");
        if (!base.isDirectory()) return; // vendor bundle not fetched in this checkout
        List<DnrEvaluator.Compiled> parts = new ArrayList<>();
        int total = 0;
        for (String id : new String[] { "ublock-filters", "easylist", "easyprivacy" }) {
            for (String kind : new String[] { "main", "regex" }) {
                File file = new File(base, kind + "/" + id + ".json");
                if (!file.isFile()) continue;
                DnrEvaluator.Compiled compiled = DnrEvaluator.compileArray(new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8));
                parts.add(compiled);
                total += compiled.rules.size();
            }
        }
        DnrEvaluator rules = new DnrEvaluator(Collections.singletonList(DnrEvaluator.group("ubolite", "asset:x", parts)));
        assertTrue("compiled " + total, total > 100000);
        // uBlock filters swap AdSense's loader for its neutered stand-in from the package.
        DnrEvaluator.Decision adsense = decide(rules, "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js", "script", "https://news.example/");
        assertEquals(DnrEvaluator.Outcome.REDIRECT, adsense.outcome);
        assertTrue(adsense.extensionPath, adsense.extensionPath.startsWith("/web_accessible_resources/"));
        assertEquals(DnrEvaluator.Outcome.BLOCK, decide(rules, "https://static.hotjar.com/c/hotjar-1.js", "script", "https://news.example/").outcome);
        // EasyPrivacy's rule is third-party only.
        assertEquals(DnrEvaluator.Outcome.NONE, decide(rules, "https://static.hotjar.com/c/hotjar-1.js", "script", "https://www.hotjar.com/").outcome);
        assertEquals(DnrEvaluator.Outcome.NONE, decide(rules, "https://news.example/article.html", "main_frame", null).outcome);
        long start = System.nanoTime();
        for (int index = 0; index < 1000; index++) decide(rules, "https://cdn.news.example/static/js/app." + index + ".js?v=3", "script", "https://news.example/");
        long perRequestMicros = (System.nanoTime() - start) / 1000 / 1000;
        System.out.println("uBO Lite defaults: " + total + " rules, " + perRequestMicros + " µs per request");
        assertTrue("a request took " + perRequestMicros + " µs", perRequestMicros < 2000);
        // A page can make a URL as long as it likes: matching it stays linear (it took 77 s at 32 KB with backtracking).
        for (String fill : new String[] { "a", "&k=v", "%2f" }) {
            StringBuilder url = new StringBuilder("https://evil.example/?");
            while (url.length() < 32000) url.append(fill);
            for (String type : new String[] { "image", "script", "xmlhttprequest" }) {
                long started = System.nanoTime();
                decide(rules, url.toString(), type, "https://evil.example/");
                long millis = (System.nanoTime() - started) / 1000000;
                assertTrue(type + " with a 32 KB URL of " + fill + " took " + millis + " ms", millis < 500);
            }
        }
        // The rules filed by a `*`-bounded literal still match.
        assertEquals(DnrEvaluator.Outcome.BLOCK, decide(rules, "https://mail.example/x%2ftrack%2fopen.php%3fid%3d1", "image", "https://mail.example/").outcome);
    }

    /** `*` matches anything, segments in order, `^` a separator or the end; linear in the URL's length. */
    @Test
    public void wildcardsMatchWithoutBacktracking() {
        DnrEvaluator rules = evaluator("[" + block(1, "*%2ftrack%2fopen.php%3f*") + "," + block(2, "||ads.example^*banner*.gif|")
            + "," + block(3, "|https://*/pixel^") + "," + block(4, "a*b*c") + "]");
        assertEquals(Integer.valueOf(1), decide(rules, "https://m.example/r?u=%2Ftrack%2Fopen.php%3Fx", "image", "https://m.example/").ruleId);
        assertEquals(Integer.valueOf(2), decide(rules, "https://cdn.ads.example/x/banner-1.gif", "image", "https://site.example/").ruleId);
        assertEquals(DnrEvaluator.Outcome.NONE, decide(rules, "https://cdn.ads.example/x/banner-1.gif?x", "image", "https://site.example/").outcome);
        assertEquals(Integer.valueOf(3), decide(rules, "https://t.example/pixel", "image", "https://site.example/").ruleId);
        assertEquals(Integer.valueOf(3), decide(rules, "https://t.example/pixel?x=1", "image", "https://site.example/").ruleId);
        assertEquals(DnrEvaluator.Outcome.NONE, decide(rules, "https://t.example/pixels", "image", "https://site.example/").outcome);
        assertEquals(Integer.valueOf(4), decide(rules, "https://x.example/zzazzbzzc", "image", null).ruleId);
        assertEquals(DnrEvaluator.Outcome.NONE, decide(rules, "https://x.example/zzczzbzza", "image", null).outcome);
        StringBuilder url = new StringBuilder("https://x.example/?");
        while (url.length() < 64000) url.append('a');
        long started = System.nanoTime();
        assertEquals(DnrEvaluator.Outcome.NONE, decide(rules, url.toString(), "image", null).outcome);
        assertTrue("linear", (System.nanoTime() - started) / 1000000 < 200);
    }
}
