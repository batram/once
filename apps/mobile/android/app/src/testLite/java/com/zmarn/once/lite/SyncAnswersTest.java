package com.zmarn.once.lite;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** The synchronous answers Java serves to content worlds: once each, in order, to their own document only. */
public class SyncAnswersTest {
    private static final String BASE = "https://0123456789abcdef0123456789abcdef.moz-extension.localhost/_once/k1/dynamic?u=";
    private static final String PAGE = BASE + "https%3A%2F%2Fsite.test%2Fpage";

    @Test public void eachBodyIsServedOnceInTheOrderStored() {
        SyncAnswers answers = new SyncAnswers();
        answers.set(PAGE, "first");
        answers.set(PAGE, "second");
        assertEquals("first", answers.take(PAGE));
        assertEquals("second", answers.take(PAGE));
        assertNull("served once", answers.take(PAGE));
        answers.set(PAGE, "again");
        answers.set(PAGE, null);
        assertNull("forgotten", answers.take(PAGE));
    }

    @Test public void theOldestDocumentsGoFirstAndLongLivedOnesDoNotExist() {
        SyncAnswers answers = new SyncAnswers();
        for (int index = 0; index < SyncAnswers.LIMIT + 10; index++) answers.set(BASE + index, "body " + index);
        assertEquals(SyncAnswers.LIMIT, answers.size());
        assertNull(answers.take(BASE + 0));
        assertNull(answers.take(BASE + 9));
        assertEquals("body 10", answers.take(BASE + 10));
        assertEquals("body " + (SyncAnswers.LIMIT + 9), answers.take(BASE + (SyncAnswers.LIMIT + 9)));
    }

    @Test public void onlyTheNamedDocumentMayReadItsAnswer() {
        assertEquals("https://site.test", SyncAnswers.allowedOrigin(PAGE, "https://site.test"));
        assertEquals("a sandboxed frame of the document", "null", SyncAnswers.allowedOrigin(PAGE, "null"));
        assertEquals("no Origin header: the document's origin", "https://site.test", SyncAnswers.allowedOrigin(PAGE, null));
        assertNull("a parent of another origin", SyncAnswers.allowedOrigin(PAGE, "https://evil.test"));
        assertNull("no document named", SyncAnswers.allowedOrigin(BASE.substring(0, BASE.indexOf('?')), "https://site.test"));
        assertEquals("http://127.0.0.1:8080", SyncAnswers.origin("http://127.0.0.1:8080/a|b{c}"));
        assertEquals("https://site.test", SyncAnswers.origin("https://user@Site.Test:443/x"));
        assertNull(SyncAnswers.origin("about:blank"));
    }

    @Test public void onlyExtensionOriginsOnceSyncPathsAreAnswered() {
        assertTrue(SyncAnswers.isSyncRequest(PAGE));
        assertFalse(SyncAnswers.isSyncRequest("https://site.test/_once/k1/dynamic"));
        assertFalse(SyncAnswers.isSyncRequest("https://0123.moz-extension.localhost/page.html?x=/_once/"));
    }
}
