package com.zmarn.once;

import android.app.ActivityManager;
import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.lang.reflect.Field;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.mozilla.geckoview.GeckoResult;
import org.mozilla.geckoview.GeckoSession;
import static org.junit.Assert.*;
import static androidx.test.espresso.Espresso.*;
import static androidx.test.espresso.action.ViewActions.click;
import static androidx.test.espresso.assertion.ViewAssertions.*;
import static androidx.test.espresso.matcher.ViewMatchers.*;
import static androidx.test.espresso.matcher.RootMatchers.isDialog;

/** Real Gecko audio, page visibility, Android backgrounding, and screen-off regression. */
@RunWith(AndroidJUnit4.class)
public class BackgroundMediaTest {
    private final Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
    private InAppBrowserSurfacePlugin plugin;
    private MainActivity activity;

    @Test public void optInSurvivesHiddenTabBackgroundAndScreenOff() throws Exception {
        exercisePlayback(false);
    }

    @Test public void videoSurvivesHiddenTabBackgroundAndScreenOff() throws Exception {
        exercisePlayback(true);
    }

    private void exercisePlayback(boolean video) throws Exception {
        Context context = instrumentation.getTargetContext();
        assertEquals("Use only the isolated local emulator", "ranchu", android.os.Build.HARDWARE);
        assertTrue(context.getPackageName().endsWith(".dev"));
        shell("input keyevent KEYCODE_WAKEUP");
        shell("wm dismiss-keyguard");
        Intent launch = new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        activity = (MainActivity) instrumentation.startActivitySync(launch);
        plugin = (InAppBrowserSurfacePlugin) activity.getBridge().getPlugin("InAppBrowserSurface").getInstance();
        boolean original = context.getSharedPreferences("reading-media", Context.MODE_PRIVATE).getBoolean("background-playback", false);
        try (ServerSocket server = new ServerSocket(0)) {
            serve(server);
            call(plugin::close, new JSObject());
            call(plugin::open, new JSObject().put("url", "http://127.0.0.1:" + server.getLocalPort() + "/")
                .put("visible", true).put("bounds", new JSObject().put("x", 0).put("y", 100).put("width", 300).put("height", 400)));
            instrumentation.runOnMainSync(() -> session().setPermissionDelegate(new GeckoSession.PermissionDelegate() {
                @Override public GeckoResult<Integer> onContentPermissionRequest(GeckoSession session, ContentPermission permission) {
                    return GeckoResult.fromValue(ContentPermission.VALUE_ALLOW);
                }
            }));
            waitForPage();
            if (video) createVideo();
            instrumentation.runOnMainSync(() -> media().setEnabled(false));
            for (int cycle = 0; cycle < 3; cycle++) {
                toggleFromMenu(true);
                assertTrue("Preference survives controller recreation", new BackgroundMedia(context).isEnabled());
                evaluate("document.querySelector('#media').play(); true");
                assertPlaying("visible");
                assertService(true);
                call(plugin::setVisible, new JSObject().put("visible", false));
                assertPlaying("hidden reading tab");
                shell("input keyevent KEYCODE_HOME");
                assertPlaying("background app");
                shell("input keyevent KEYCODE_SLEEP");
                assertPlaying("screen off");
                assertService(true);
                shell("input keyevent KEYCODE_WAKEUP");
                shell("wm dismiss-keyguard");
                shell("am start -W -n " + context.getPackageName() + "/com.zmarn.once.MainActivity");
                // Turning it off while the reading tab is hidden must suspend current media.
                toggleFromMenu(false);
                Thread.sleep(700);
                double before = time();
                Thread.sleep(1600);
                assertEquals("Disabled playback stays suspended", before, time(), 0.15);
                assertService(false);
                call(plugin::setVisible, new JSObject().put("visible", true));
            }
            instrumentation.runOnMainSync(() -> media().setEnabled(true));
            evaluate("document.querySelector('#media').play(); true");
            assertPlaying("before explicit pause");
            evaluate("document.querySelector('#media').pause(); true");
            assertService(false);
            evaluate("document.querySelector('#media').play(); true");
            assertService(true);
            android.app.NotificationManager notifications = context.getSystemService(android.app.NotificationManager.class);
            boolean foundPause = false;
            for (android.service.notification.StatusBarNotification notification : notifications.getActiveNotifications()) {
                if (notification.getNotification().actions == null) continue;
                for (android.app.Notification.Action action : notification.getNotification().actions) {
                    if ("Pause".contentEquals(action.title)) { action.actionIntent.send(); foundPause = true; }
                }
            }
            assertTrue("Playback notification supplies Pause", foundPause);
            assertService(false);
            assertEquals("Notification pauses page media", "true", evaluate("document.querySelector('#media').paused"));
            evaluate("document.querySelector('#media').play(); true");
            assertService(true);
            call(plugin::close, new JSObject());
            assertService(false);
        } finally {
            shell("input keyevent KEYCODE_WAKEUP");
            shell("wm dismiss-keyguard");
            instrumentation.runOnMainSync(() -> media().setEnabled(original));
            call(plugin::close, new JSObject());
            instrumentation.runOnMainSync(activity::finish);
        }
    }

    private void toggleFromMenu(boolean enabled) throws Exception {
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

    private void assertPlaying(String state) throws Exception {
        Thread.sleep(500);
        double before = time();
        Thread.sleep(1600);
        double after = time();
        double duration = Double.parseDouble(evaluate("document.querySelector('#media').duration"));
        double elapsed = (after - before + duration) % duration;
        assertTrue(state + ": media clock did not advance (" + before + " -> " + after + ")",
            elapsed > 0.7 && elapsed < 3.5);
        android.util.Log.i("OnceMediaTest", state + ": " + before + " -> " + after);
    }

    private double time() throws Exception { return Double.parseDouble(evaluate("document.querySelector('#media').currentTime")); }

    private void createVideo() throws Exception {
        // Generate real VP8/Opus media locally, without external downloads or codec tools.
        evaluate("""
            (async () => {
              const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 90;
              document.body.append(canvas);
              const paint = canvas.getContext('2d'); let frame = 0;
              const draw = setInterval(() => { paint.fillStyle = ++frame % 2 ? 'blue' : 'green'; paint.fillRect(0, 0, 160, 90); }, 100);
              const stream = canvas.captureStream(10);
              const source = document.querySelector('#media'); await source.play();
              const captured = source.captureStream ? source.captureStream() : source.mozCaptureStream();
              stream.addTrack(captured.getAudioTracks()[0]);
              const recorder = new MediaRecorder(stream, {mimeType: 'video/webm;codecs=vp8,opus'});
              const chunks = []; recorder.ondataavailable = event => chunks.push(event.data);
              recorder.onstop = () => {
                clearInterval(draw); stream.getTracks().forEach(track => track.stop()); source.pause();
                const video = document.createElement('video'); video.id = 'media'; video.controls = true; video.loop = true;
                video.src = URL.createObjectURL(new Blob(chunks, {type: recorder.mimeType}));
                document.querySelector('#media').replaceWith(video); canvas.remove();
                document.body.dataset.videoReady = 'true';
              };
              recorder.onerror = event => document.body.dataset.videoError = String(event.error);
              recorder.start(); setTimeout(() => recorder.stop(), 6000);
            })().catch(error => document.body.dataset.videoError = String(error)); true
            """);
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20);
        do {
            if ("true".equals(evaluate("document.body.dataset.videoReady === 'true'"))) return;
            assertEquals("Video fixture generation", "null", evaluate("document.body.dataset.videoError || null"));
            Thread.sleep(200);
        } while (System.nanoTime() < deadline);
        fail("Video fixture did not reach readiness");
    }

    private void assertService(boolean expected) throws Exception {
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

    private void waitForPage() throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
        do {
            if (field("bridgePort") != null && "true".equals(evaluate("!!document.querySelector('audio')"))) return;
            Thread.sleep(100);
        } while (System.nanoTime() < deadline);
        fail("Media fixture did not reach readiness");
    }

    private String evaluate(String script) throws Exception { return call(plugin::evaluateJavaScript, new JSObject().put("script", script)).value.getString("value"); }
    private GeckoSession session() { return (GeckoSession) field("session"); }
    private BackgroundMedia media() { return (BackgroundMedia) field("backgroundMedia"); }
    private Object field(String name) {
        try { Field field = plugin.getClass().getDeclaredField(name); field.setAccessible(true); return field.get(plugin); }
        catch (Exception error) { throw new AssertionError(error); }
    }
    private void shell(String command) throws Exception {
        try (java.io.InputStream output = new android.os.ParcelFileDescriptor.AutoCloseInputStream(
                instrumentation.getUiAutomation().executeShellCommand(command))) {
            byte[] buffer = new byte[1024];
            while (output.read(buffer) != -1) {}
        }
        Thread.sleep(500);
    }
    private Call call(Consumer<PluginCall> operation, JSObject data) throws Exception {
        Call call = new Call(data);
        instrumentation.runOnMainSync(() -> operation.accept(call));
        assertTrue("Plugin call timed out", call.done.await(35, TimeUnit.SECONDS));
        assertNull(call.error, call.error);
        return call;
    }

    private void serve(ServerSocket server) {
        // A quiet PCM tone avoids network, codecs, and third-party autoplay policies.
        int samples = 8000 * 60;
        ByteBuffer wav = ByteBuffer.allocate(44 + samples * 2).order(ByteOrder.LITTLE_ENDIAN);
        wav.put("RIFF".getBytes(StandardCharsets.US_ASCII)).putInt(36 + samples * 2);
        wav.put("WAVEfmt ".getBytes(StandardCharsets.US_ASCII)).putInt(16).putShort((short) 1).putShort((short) 1);
        wav.putInt(8000).putInt(16000).putShort((short) 2).putShort((short) 16);
        wav.put("data".getBytes(StandardCharsets.US_ASCII)).putInt(samples * 2);
        for (int index = 0; index < samples; index++) wav.putShort((short) (Math.sin(index * Math.PI * 440 / 8000) * 100));
        byte[] html = ("<!doctype html><title>Once background media fixture</title><audio id='media' controls loop src='data:audio/wav;base64,"
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

    private static final class Call extends PluginCall {
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
