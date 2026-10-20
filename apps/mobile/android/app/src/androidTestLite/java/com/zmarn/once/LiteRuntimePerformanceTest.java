package com.zmarn.once;

import android.view.ViewGroup;
import android.webkit.WebView;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import com.zmarn.once.lite.LiteTargets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/** Isolated transport measurements using the native extension-engine fixture. */
@RunWith(AndroidJUnit4.class)
public class LiteRuntimePerformanceTest {
    private final LiteExtensionEngineTest host = new LiteExtensionEngineTest();

    @Before public void start() throws Exception { host.start(); }
    @After public void stop() throws Exception { host.stop(); }

    /** Compare the former broker-body path with the native path on identical local CSP documents. */
    @Test
    public void cspBodyTransportBenchmark() throws Exception {
        AtomicReference<LiteTargets.Attachment> attachment = new AtomicReference<>();
        int tabId = host.engine.nextTabId();
        AtomicReference<String> expectedUrl = new AtomicReference<>();
        AtomicReference<CountDownLatch> loaded = new AtomicReference<>();
        host.ui(() -> {
            host.tab = new WebView(host.activity);
            host.tab.getSettings().setJavaScriptEnabled(true);
            host.tab.setWebViewClient(new android.webkit.WebViewClient() {
                @Override public void onPageFinished(WebView view, String url) {
                    if (url.equals(expectedUrl.get()) && loaded.get() != null) loaded.get().countDown();
                }
            });
            host.activity.addContentView(host.tab, new ViewGroup.LayoutParams(600, 600));
            attachment.set(host.engine.targets().register(host.tab, "once-tab-" + java.util.UUID.randomUUID(), "tab", tabId, null, null, true));
        });
        host.reportTab(tabId, host.fixture.url("/page.html"), attachment.get());
        CountDownLatch ready = new CountDownLatch(1);
        attachment.get().whenReady(10000, ready::countDown);
        assertTrue(ready.await(15, TimeUnit.SECONDS));
        host.ui(() -> host.tab.loadUrl(host.fixture.url("/page.html")));
        host.untilEvaluates("document.title", "\"filter probe\"", 30);
        assertEquals("tab", evaluateBroker("onceLiteBroker.targets.get(" + JSONObject.quote(attachment.get().targetId()) + ").kind"));
        // Measurement instrumentation only: retain the old algorithm as a baseline, without a product flag.
        evaluateBroker("window.__benchTarget=" + JSONObject.quote(attachment.get().targetId()) + ";window.__bodyNative = onceLiteBroker.webRequest.fulfillWithBody;"
            + "window.__bodyLegacy = async function(targetId,event,headers,statusCode){"
            + "const result=await this.cdp(targetId,'Fetch.getResponseBody',{requestId:event.requestId,oncePause:event.oncePause});"
            + "let body=result.body;if(!result.base64Encoded){const bytes=new TextEncoder().encode(body);let binary='';for(let offset=0;offset<bytes.length;offset+=0x8000)binary+=String.fromCharCode(...bytes.subarray(offset,offset+0x8000));body=btoa(binary);}"
            + "await this.cdp(targetId,'Fetch.fulfillRequest',{requestId:event.requestId,oncePause:event.oncePause,responseCode:statusCode,"
            + "responseHeaders:headers.filter(h=>!['content-length','content-encoding','transfer-encoding'].includes(h.name.toLowerCase())),body});};"
            + "window.__bodyCharacters=0;const original=onceLiteBroker.channel.request.bind(onceLiteBroker.channel);window.__bodyRequest=original;"
            + "onceLiteBroker.channel.request=async function(method,params){if(method==='cdp.command'&&params.targetId===window.__benchTarget)window.__bodyCharacters+=(params.params?.body?.length||0);"
            + "const answer=await original(method,params);if(method==='cdp.command'&&params.targetId===window.__benchTarget)window.__bodyCharacters+=(answer?.body?.length||0);return answer;};true");
        JSONArray samples = new JSONArray();
        try {
            // Warm both paths before collecting samples, including the extension worlds and local fixture.
            for (boolean nativeBody : new boolean[] { false, true }) {
                evaluateBroker("onceLiteBroker.webRequest.fulfillWithBody=window.__body" + (nativeBody ? "Native" : "Legacy") + ";true");
                String url = host.fixture.url("/large/65536?warmup-" + nativeBody);
                expectedUrl.set(url); loaded.set(new CountDownLatch(1));
                host.ui(() -> host.tab.loadUrl(url));
                assertTrue("warmup loaded", loaded.get().await(30, TimeUnit.SECONDS));
            }
            for (int bytes : new int[] { 64 * 1024, 512 * 1024, 2 * 1024 * 1024 }) {
                for (int repeat = 0; repeat < 3; repeat++) for (boolean nativeBody : new boolean[] { repeat % 2 == 0, repeat % 2 != 0 }) {
                    evaluateBroker("onceLiteBroker.webRequest.fulfillWithBody=window.__body" + (nativeBody ? "Native" : "Legacy") + ";window.__bodyCharacters=0;true");
                    String path = "/large/" + bytes + "?" + repeat + "-" + nativeBody;
                    expectedUrl.set(host.fixture.url(path)); loaded.set(new CountDownLatch(1));
                    long start = System.nanoTime();
                    host.ui(() -> host.tab.loadUrl(host.fixture.url(path)));
                    assertTrue("benchmark document loaded", loaded.get().await(30, TimeUnit.SECONDS));
                    host.untilEvaluates("document.title === " + JSONObject.quote(path) + " && document.readyState === 'complete'", "true", 30);
                    long elapsed = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start);
                    long navigationMs = Long.parseLong(host.evaluate("Math.round(performance.getEntriesByType('navigation')[0].duration)"));
                    long characters = Long.parseLong(evaluateBroker("window.__bodyCharacters"));
                    if (nativeBody) assertEquals("document body never crosses broker IPC", 0, characters);
                    else assertTrue("baseline transfers the body both ways", characters >= bytes * 2L);
                    samples.put(new JSONObject().put("bytes", bytes).put("native", nativeBody).put("ms", elapsed).put("navigationMs", navigationMs).put("brokerBodyCharacters", characters));
                }
            }
        } finally {
            evaluateBroker("onceLiteBroker.webRequest.fulfillWithBody=window.__bodyNative;onceLiteBroker.channel.request=window.__bodyRequest;true");
            host.results.put("cspBodySamples", samples);
            host.ui(() -> host.engine.targets().unregister(attachment.get()));
        }
    }

    @Test
    public void keyedStorageReadsLegacySplitAndChunkedValues() throws Exception {
        String result = evaluateBroker("(async()=>{"
            + "const b=onceLiteBroker,s=[...b.hosts.values()][0].store,n='keyed-read-test-'+crypto.randomUUID()+'.json';"
            + "try{const large='x'.repeat(2*1024*1024)+'🐢';await s.write(n,{small:1,large,empty:null});"
            + "const legacy=await s.readKeys(n,['small','absent','empty']);"
            + "await s.patch(n,{small:2},[]);const split=await s.readKeys(n,['small','absent']);"
            + "const big=await s.readKeys(n,['large']);await s.patch(n,{},['small']);"
            + "const removed=await s.readKeys(n,['small']);"
            + "return JSON.stringify({legacy,split,largeMatches:big.large===large,removed});"
            + "}finally{await b.channel.request('files.remove',{directory:s.directory+'/'+n});"
            + "await b.channel.request('files.remove',{directory:s.directory+'/'+n+'.d'});}})()");
        JSONObject value = new JSONObject(result);
        assertEquals(1, value.getJSONObject("legacy").getInt("small"));
        assertTrue(value.getJSONObject("legacy").isNull("empty"));
        assertFalse(value.getJSONObject("legacy").has("absent"));
        assertEquals(2, value.getJSONObject("split").getInt("small"));
        assertEquals(1, value.getJSONObject("split").length());
        assertTrue(value.getBoolean("largeMatches"));
        assertEquals(0, value.getJSONObject("removed").length());
    }

    private String evaluateBroker(String expression) throws Exception {
        com.zmarn.once.devtools.DevToolsClient client = com.zmarn.once.devtools.DevToolsClient.current();
        for (com.zmarn.once.devtools.DevToolsClient.Target target : client.targets()) {
            if (target.url == null || !target.url.contains("/lite-runtime.html")) continue;
            JSONObject value = client.call(target.sessionId, "Runtime.evaluate", new JSONObject().put("expression", expression).put("returnByValue", true).put("awaitPromise", true), 10000);
            if (value.has("exceptionDetails")) throw new AssertionError(value.toString());
            return String.valueOf(value.getJSONObject("result").opt("value"));
        }
        throw new AssertionError("No broker target");
    }

}
