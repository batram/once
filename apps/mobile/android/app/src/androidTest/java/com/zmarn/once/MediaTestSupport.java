package com.zmarn.once;

import android.app.ActivityManager;
import android.app.Instrumentation;
import androidx.test.platform.app.InstrumentationRegistry;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;
import org.mozilla.geckoview.GeckoSession;
import static org.junit.Assert.*;
import static androidx.test.espresso.Espresso.*;
import static androidx.test.espresso.action.ViewActions.click;
import static androidx.test.espresso.assertion.ViewAssertions.*;
import static androidx.test.espresso.matcher.ViewMatchers.*;
import static androidx.test.espresso.matcher.RootMatchers.isDialog;

/** Shared media fixture, transport assertions and device interaction helpers. */
abstract class MediaTestSupport {
    protected final Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
    protected InAppBrowserSurfacePlugin plugin;
    protected MainActivity activity;

    protected android.media.session.MediaController controller() {
        for (android.service.notification.StatusBarNotification notification : instrumentation.getTargetContext()
                .getSystemService(android.app.NotificationManager.class).getActiveNotifications()) {
            android.media.session.MediaSession.Token token = notification.getNotification().extras.getParcelable(android.app.Notification.EXTRA_MEDIA_SESSION);
            if (token != null) return new android.media.session.MediaController(instrumentation.getTargetContext(), token);
        }
        throw new AssertionError("No Android media controls");
    }

    protected void tapVideo() throws Exception {
        tapElement("video");
    }

    protected void tapElement(String selector) throws Exception {
        org.json.JSONObject point = new org.json.JSONObject(evaluate("(() => { const r = document.querySelector('" + selector + "').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()"));
        int[] origin = new int[2];
        instrumentation.runOnMainSync(() -> ((android.view.View) field("surface")).getLocationOnScreen(origin));
        double scale = ((android.view.View) field("surface")).getWidth() / Double.parseDouble(evaluate("innerWidth"));
        shell("input tap " + (origin[0] + Math.round(point.getDouble("x") * scale)) + " " +
            (origin[1] + Math.round(point.getDouble("y") * scale)));
    }

    protected void capture(String name) throws Exception {
        try (java.io.OutputStream image = new java.io.FileOutputStream(new java.io.File(activity.getExternalFilesDir(null), name))) {
            instrumentation.getUiAutomation().takeScreenshot().compress(android.graphics.Bitmap.CompressFormat.PNG, 100, image);
        }
    }

    protected void dismissFullscreenHelp() {
        android.app.UiAutomation automation = instrumentation.getUiAutomation();
        android.accessibilityservice.AccessibilityServiceInfo info = automation.getServiceInfo();
        info.flags |= android.accessibilityservice.AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS;
        automation.setServiceInfo(info);
        for (android.view.accessibility.AccessibilityWindowInfo window : automation.getWindows()) {
            android.view.accessibility.AccessibilityNodeInfo root = window.getRoot();
            if (root == null) continue;
            for (android.view.accessibility.AccessibilityNodeInfo node : root.findAccessibilityNodeInfosByText("Got it")) {
                node.performAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_CLICK);
            }
        }
    }

    protected void toggleFromMenu(boolean enabled) throws Exception {
        Call menu = new Call(new JSObject().put("browserControls", true));
        instrumentation.runOnMainSync(() -> plugin.showMenu(menu));
        onView(withText("Keep media playing in background")).inRoot(isDialog()).check(matches(enabled ? isNotChecked() : isChecked()));
        Thread.sleep(500);
        try (java.io.OutputStream image = new java.io.FileOutputStream(new java.io.File(activity.getExternalFilesDir(null), "media-menu.png"))) {
            instrumentation.getUiAutomation().takeScreenshot().compress(android.graphics.Bitmap.CompressFormat.PNG, 100, image);
        }
        onView(withText("Keep media playing in background")).inRoot(isDialog()).perform(click());
        onView(withText("Keep media playing in background")).inRoot(isDialog()).check(matches(enabled ? isChecked() : isNotChecked()));
        pressBack();
    }

    protected void assertPlaying(String state) throws Exception {
        Thread.sleep(500);
        // Decoder startup on a busy physical phone is asynchronous. Measure
        // steady playback only after it has actually started producing media.
        long startDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (time() < 0.5 && System.nanoTime() < startDeadline) Thread.sleep(100);
        boolean visibleVideo = "true".equals(evaluate("document.querySelector('#media').tagName === 'VIDEO' && document.visibilityState === 'visible'"));
        double frames = visibleVideo ? Double.parseDouble(evaluate("document.querySelector('#media').getVideoPlaybackQuality().totalVideoFrames")) : 0;
        double before = time();
        Thread.sleep(1600);
        double after = time();
        double duration = Double.parseDouble(evaluate("document.querySelector('#media').duration"));
        double elapsed = (after - before + duration) % duration;
        assertEquals(state + ": decoder error", "null", evaluate("document.querySelector('#media').error?.message || null"));
        if (visibleVideo) assertTrue(state + ": video frames did not advance",
            Double.parseDouble(evaluate("document.querySelector('#media').getVideoPlaybackQuality().totalVideoFrames")) > frames);
        String detail = elapsed > 0.7 && elapsed < 3.5 ? "" : evaluate("(() => {const v=document.querySelector('#media');return {paused:v.paused,ended:v.ended,ready:v.readyState,error:v.error?.message,loop:v.loop,visibility:document.visibilityState,fullscreen:!!document.fullscreenElement}})()");
        assertTrue(state + ": media clock did not advance (" + before + " -> " + after + "): " + detail,
            elapsed > 0.7 && elapsed < 3.5);
        android.util.Log.i("OnceMediaTest", state + ": " + before + " -> " + after);
    }

    protected double time() throws Exception { return Double.parseDouble(evaluate("document.querySelector('#media').currentTime")); }

    protected void createVideo() throws Exception {
        // A fixed H.264/AAC clip avoids device-dependent MediaRecorder output.
        byte[] clip;
        try (java.io.InputStream input = instrumentation.getContext().getAssets().open("playback.mp4")) {
            java.io.ByteArrayOutputStream output = new java.io.ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int count;
            while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
            clip = output.toByteArray();
        }
        String source = "data:video/mp4;base64," + android.util.Base64.encodeToString(clip, android.util.Base64.NO_WRAP);
        evaluate("const video=document.createElement('video'); video.id='media'; video.controls=true; video.loop=true;"
            + "video.src='" + source + "'; document.querySelector('#media').replaceWith(video); true");
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20);
        do {
            if ("true".equals(evaluate("document.querySelector('#media').readyState >= 2"))) return;
            assertEquals("Video fixture decoding", "null", evaluate("document.querySelector('#media').error?.message || null"));
            Thread.sleep(200);
        } while (System.nanoTime() < deadline);
        fail("Video fixture did not reach readiness");
    }

    protected void assertService(boolean expected) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        boolean running;
        do {
            running = instrumentation.getTargetContext().getSystemService(ActivityManager.class).getRunningServices(100)
                .stream().anyMatch(service -> BackgroundMediaService.class.getName().equals(service.service.getClassName()) && service.foreground);
            if (running == expected) return;
            Thread.sleep(100);
        } while (System.nanoTime() < deadline);
        assertEquals("Foreground playback service", expected, running);
    }

    protected void waitForPage() throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
        do {
            if (field("bridgePort") != null && "true".equals(evaluate("!!document.querySelector('audio')"))) return;
            Thread.sleep(100);
        } while (System.nanoTime() < deadline);
        fail("Media fixture did not reach readiness");
    }

    protected String evaluate(String script) throws Exception { return call(plugin::evaluateJavaScript, new JSObject().put("script", script)).value.getString("value"); }
    protected GeckoSession session() { return (GeckoSession) field("session"); }
    protected BackgroundMedia media() { return (BackgroundMedia) field("backgroundMedia"); }
    protected Object field(String name) {
        return GeckoTestSupport.field(plugin, name);
    }
    protected void shell(String command) throws Exception {
        try (java.io.InputStream output = new android.os.ParcelFileDescriptor.AutoCloseInputStream(
                instrumentation.getUiAutomation().executeShellCommand(command))) {
            byte[] buffer = new byte[1024];
            while (output.read(buffer) != -1) {}
        }
        Thread.sleep(500);
    }
    protected Call call(Consumer<PluginCall> operation, JSObject data) throws Exception {
        Call call = new Call(data);
        instrumentation.runOnMainSync(() -> operation.accept(call));
        assertTrue("Plugin call timed out", call.done.await(35, TimeUnit.SECONDS));
        assertNull(call.error, call.error);
        return call;
    }

    protected void serve(ServerSocket server) {
        serve(server, "");
    }

    protected void serve(ServerSocket server, String controls) {
        // A quiet PCM tone avoids network, codecs, and third-party autoplay policies.
        int samples = 8000 * 60;
        ByteBuffer wav = ByteBuffer.allocate(44 + samples * 2).order(ByteOrder.LITTLE_ENDIAN);
        wav.put("RIFF".getBytes(StandardCharsets.US_ASCII)).putInt(36 + samples * 2);
        wav.put("WAVEfmt ".getBytes(StandardCharsets.US_ASCII)).putInt(16).putShort((short) 1).putShort((short) 1);
        wav.putInt(8000).putInt(16000).putShort((short) 2).putShort((short) 16);
        wav.put("data".getBytes(StandardCharsets.US_ASCII)).putInt(samples * 2);
        for (int index = 0; index < samples; index++) wav.putShort((short) (Math.sin(index * Math.PI * 440 / 8000) * 100));
        byte[] html = ("<!doctype html><title>Once background media fixture</title>" + controls + "<audio id='media' controls loop src='data:audio/wav;base64,"
            + android.util.Base64.encodeToString(wav.array(), android.util.Base64.NO_WRAP) + "'></audio>").getBytes(StandardCharsets.UTF_8);
        new Thread(() -> {
            while (!server.isClosed()) {
                try (Socket socket = server.accept()) {
                    java.io.BufferedReader reader = new java.io.BufferedReader(new java.io.InputStreamReader(socket.getInputStream()));
                    String line;
                    while ((line = reader.readLine()) != null && !line.isEmpty()) {}
                    socket.getOutputStream().write(("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: " + html.length
                        + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
                    socket.getOutputStream().write(html);
                } catch (Exception error) { if (!server.isClosed()) throw new AssertionError(error); }
            }
        }, "background-media-fixture").start();
    }

    protected static final class Call extends PluginCall {
        final CountDownLatch done = new CountDownLatch(1);
        volatile JSObject value;
        volatile String error;
        Call(JSObject data) { super(null, "InAppBrowserSurface", "test", "test", data); }
        @Override public void resolve() { done.countDown(); }
        @Override public void resolve(JSObject result) { value = result; done.countDown(); }
        @Override public void reject(String message) { error = message; done.countDown(); }
        @Override public void reject(String message, Exception cause) { reject(message + ": " + cause); }
    }
}
