package com.zmarn.once;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import com.getcapacitor.JSObject;
import java.net.ServerSocket;
import java.util.concurrent.TimeUnit;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.mozilla.geckoview.GeckoResult;
import org.mozilla.geckoview.GeckoSession;
import static org.junit.Assert.*;

/** Exercises the standard page API through real taps on Android. */
@RunWith(AndroidJUnit4.class)
public class StandardPipTest extends MediaTestSupport {
    @Test public void standardVideoPipFromInline() throws Exception {
        assertTrue("Use the emulator or isolated physical test profile",
            "ranchu".equals(android.os.Build.HARDWARE) ||
            instrumentation.getTargetContext().getPackageName().equals("com.zmarn.once.geckotest.dev"));
        GeckoTestSupport support = new GeckoTestSupport();
        support.start(); activity = support.activity; plugin = support.plugin;
        boolean original = media().isEnabled();
        try (ServerSocket server = new ServerSocket(0)) {
            serve(server, """
                <meta name="viewport" content="width=device-width,initial-scale=1">
                <button id="pip" style="width:200px;height:60px" onclick="document.querySelector('#media').requestPictureInPicture().then(w=>document.body.dataset.entered=w.width+'x'+w.height).catch(e=>document.body.dataset.pipError=e.name+':'+e.message)">Picture in picture</button>
                <script>document.addEventListener('enterpictureinpicture',()=>document.body.dataset.enterEvents=String(1+Number(document.body.dataset.enterEvents||0)),true);document.addEventListener('leavepictureinpicture',()=>document.body.dataset.leaveEvents=String(1+Number(document.body.dataset.leaveEvents||0)),true)</script>
                """);
            call(plugin::close, new JSObject());
            call(plugin::open, new JSObject().put("url", "http://127.0.0.1:" + server.getLocalPort() + "/")
                .put("visible", true).put("bounds", new JSObject().put("x", 0).put("y", 100).put("width", 300).put("height", 400)));
            support.ui(() -> {
                media().setEnabled(false);
                session().setPermissionDelegate(new GeckoSession.PermissionDelegate() {
                    @Override public GeckoResult<Integer> onContentPermissionRequest(GeckoSession source, ContentPermission permission) {
                        return GeckoResult.fromValue(ContentPermission.VALUE_ALLOW);
                    }
                });
            });
            waitForPage(); createVideo();
            assertEquals("Standard PiP is exposed in page world", "true", evaluate("window.wrappedJSObject.document.pictureInPictureEnabled"));
            evaluate("document.querySelector('#media').play(); true");
            assertPlaying("inline before direct PiP");
            for (boolean explicitExit : new boolean[] { true, false }) {
                evaluate("delete document.body.dataset.entered; delete document.body.dataset.pipError; document.body.style.background='" + (explicitExit ? "white" : "#202124") + "'; true");
                tapElement("#pip");
                support.until("One inline click enters native PiP: " + evaluate("document.body.dataset.pipError || null"), activity::isInPictureInPictureMode, 10);
                assertEquals("Direct PiP does not request DOM fullscreen", "true", evaluate("document.fullscreenElement === null"));
                long enteredDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
                while (!"true".equals(evaluate("!!document.body.dataset.entered || !!document.body.dataset.pipError")) && System.nanoTime() < enteredDeadline) Thread.sleep(100);
                android.util.Log.i("OnceMediaTest", "Web PiP state: " + evaluate("({entered:document.body.dataset.entered,error:document.body.dataset.pipError,element:window.wrappedJSObject.document.pictureInPictureElement?.tagName,events:document.body.dataset.enterEvents})"));
                assertEquals("Standard PiP tracks the selected video", "true", evaluate("window.wrappedJSObject.document.pictureInPictureElement === window.wrappedJSObject.document.querySelector('#media')"));
                assertEquals("Request promise resolves", "true", evaluate("!!document.body.dataset.entered"));
                assertEquals("No request error", "null", evaluate("document.body.dataset.pipError || null"));
                assertPlaying("direct API PiP video");
                assertEquals("Video fills the PiP viewport", "true", evaluate("(()=>{const r=document.querySelector('#media').getBoundingClientRect();return Math.abs(r.width-innerWidth)<2&&Math.abs(r.height-innerHeight)<2})()"));
                capture("direct-pip-" + (explicitExit ? "light" : "dark") + ".png");
                controller().getTransportControls().pause();
                Thread.sleep(500);
                assertEquals("PiP Pause remains a real pause", "true", evaluate("document.querySelector('#media').paused"));
                controller().getTransportControls().play();
                assertPlaying("direct API PiP controls");
                if (explicitExit) evaluate("window.wrappedJSObject.document.exitPictureInPicture().then(()=>document.body.dataset.exited='true');true");
                else shell("am start -W -n " + activity.getPackageName() + "/com.zmarn.once.MainActivity");
                support.until("PiP returns to inline", () -> !activity.isInPictureInPictureMode() && activity.hasWindowFocus() && !plugin.video.isFullscreen(), 10);
                assertEquals("PiP state clears on return", "true", evaluate("window.wrappedJSObject.document.pictureInPictureElement === null"));
                assertEquals("Native fullscreen never remains after return", "true", evaluate("document.fullscreenElement === null"));
                assertEquals("PiP styling is removed", "true", evaluate("!document.querySelector('[data-once-pip-video]')"));
                assertPlaying("inline after direct PiP");
                capture("direct-pip-return-" + (explicitExit ? "light" : "dark") + ".png");
            }
            assertEquals("Both native entries emit events", "\"2\"", evaluate("document.body.dataset.enterEvents"));
            assertEquals("Both native exits emit events", "\"2\"", evaluate("document.body.dataset.leaveEvents"));
        } finally {
            shell("am start -W -n " + activity.getPackageName() + "/com.zmarn.once.MainActivity");
            support.ui(() -> media().setEnabled(original));
            call(plugin::close, new JSObject());
            support.ui(activity::finish);
        }
    }

}
