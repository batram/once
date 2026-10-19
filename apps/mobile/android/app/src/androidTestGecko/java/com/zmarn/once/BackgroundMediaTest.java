package com.zmarn.once;

import android.app.ActivityManager;
import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import androidx.test.ext.junit.runners.AndroidJUnit4;
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
public class BackgroundMediaTest extends MediaTestSupport {

    @Test public void optInSurvivesHiddenTabBackgroundAndScreenOff() throws Exception {
        exercisePlayback(false);
    }

    @Test public void videoSurvivesHiddenTabBackgroundAndScreenOff() throws Exception {
        exercisePlayback(true);
    }

    @Test public void fullscreenVideoEntersPipWithoutBackgroundOptIn() throws Exception {
        GeckoTestSupport support = new GeckoTestSupport();
        assertTrue("Use the emulator or the isolated Gecko test app on a physical device",
            "ranchu".equals(android.os.Build.HARDWARE) ||
            instrumentation.getTargetContext().getPackageName().equals("com.zmarn.once.geckotest.dev"));
        support.start();
        activity = support.activity; plugin = support.plugin;
        boolean original = media().isEnabled();
        int orientation = activity.getRequestedOrientation();
        try (ServerSocket server = new ServerSocket(0)) {
            serve(server, """
                <meta name="viewport" content="width=device-width,initial-scale=1">
                <button id="fullscreen" onclick="document.body.dataset.tapped='true';document.querySelector(document.body.dataset.target || '#player').requestFullscreen().catch(e=>document.body.dataset.fullscreenError=String(e))">Fullscreen video</button>
                """);
            call(plugin::close, new JSObject());
            call(plugin::open, new JSObject().put("url", "http://127.0.0.1:" + server.getLocalPort() + "/")
                .put("visible", true).put("bounds", new JSObject().put("x", 0).put("y", 100).put("width", 300).put("height", 400)));
            support.ui(() -> {
                media().setEnabled(false);
                session().setPermissionDelegate(new GeckoSession.PermissionDelegate() {
                    @Override public GeckoResult<Integer> onContentPermissionRequest(GeckoSession source, ContentPermission permission) {
                        return GeckoResult.fromValue(permission.permission == PERMISSION_AUTOPLAY_AUDIBLE || permission.permission == PERMISSION_AUTOPLAY_INAUDIBLE
                            ? ContentPermission.VALUE_ALLOW : ContentPermission.VALUE_DENY);
                    }
                });
            });
            waitForPage(); createVideo();
            evaluate("""
                const style = document.createElement('style');
                style.textContent = 'body{margin:0}#player:fullscreen{width:100vw;height:100vh;background:black}#player:fullscreen video{width:100%;height:100%;object-fit:contain}video:fullscreen{width:100vw;height:100vh}button{display:block;width:200px;height:60px}';
                document.head.append(style);
                const player = document.createElement('div'); player.id='player';
                document.querySelector('#media').before(player); player.append(document.querySelector('#media'));
                true
                """);
            // A wrapper (like YouTube's player) and the video itself, in both page themes.
            for (String target : new String[] { "#player", "#media" }) {
                if (target.equals("#media")) {
                    support.ui(() -> activity.setRequestedOrientation(android.content.pm.ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE));
                    support.until("Landscape viewport", () -> activity.getWindow().getDecorView().getWidth() > activity.getWindow().getDecorView().getHeight(), 10);
                    call(plugin::setBounds, new JSObject().put("x", 0).put("y", 50).put("width", 600).put("height", 250));
                }
                evaluate("document.body.dataset.target='" + target + "'; document.body.style.background='" +
                    (target.equals("#player") ? "white" : "#202124") + "'; document.querySelector('#media').play(); true");
                long started = System.nanoTime() + TimeUnit.SECONDS.toNanos(15);
                while (!"true".equals(evaluate("document.querySelector('#media').currentTime > 0.5")) && System.nanoTime() < started) Thread.sleep(200);
                assertPlaying("inline video");
                int[] originalSize = new int[2];
                support.ui(() -> { originalSize[0] = plugin.surface.getWidth(); originalSize[1] = plugin.surface.getHeight(); });
                tapElement("#fullscreen");
                android.util.Log.i("OnceMediaTest", "Fullscreen request: " + evaluate("({fullscreen:document.fullscreenElement?.id,tapped:document.body.dataset.tapped,error:document.body.dataset.fullscreenError,enabled:document.fullscreenEnabled,paused:document.querySelector('video').paused,width:innerWidth,height:innerHeight})"));
                support.ui(() -> android.util.Log.i("OnceMediaTest", "Native fullscreen=" + plugin.video.isFullscreen() + " playing=" + media().state.playing
                    + " visible=" + plugin.visible + " owner=" + plugin.ownsForeground() + " metadata=" + (media().fullscreenVideo == null ? "null" : media().fullscreenVideo.width + "x" + media().fullscreenVideo.height)));
                capture("fullscreen-request.png");
                support.until("Gecko fullscreen video must be eligible for PiP", () -> plugin.video.canPip(), 10);
                dismissFullscreenHelp();
                support.until("Fullscreen surface fills the native window", () -> plugin.surface.getWidth() == activity.getWindow().getDecorView().getWidth()
                    && plugin.surface.getHeight() == activity.getWindow().getDecorView().getHeight(), 10);
                assertEquals("true", evaluate("document.fullscreenElement === document.querySelector('" + target + "')"));
                assertEquals("Fullscreen video fills the browser viewport", "true", evaluate("(() => {const r=document.querySelector('video').getBoundingClientRect();return Math.abs(r.width-innerWidth)<2 && Math.abs(r.height-innerHeight)<2})()"));
                support.ui(() -> {
                    assertFalse("Fullscreen disables pull to refresh", plugin.refreshSurface.isEnabled());
                    assertEquals(0, plugin.refreshSurface.getX(), 0.1);
                    assertEquals(0, plugin.refreshSurface.getY(), 0.1);
                });
                capture("fullscreen-" + (target.equals("#player") ? "light" : "dark") + ".png");
                shell("input keyevent KEYCODE_HOME");
                support.until("Home enters Android PiP", activity::isInPictureInPictureMode, 10);
                support.ui(() -> android.util.Log.i("OnceMediaTest", "PiP policy=" + GeckoTestSupport.field(media(), "inPictureInPicture")
                    + " playing=" + media().state.playing + " active=" + GeckoTestSupport.field(media(), "active")
                    + " metadata=" + (media().fullscreenVideo == null ? "null" : media().fullscreenVideo.width + "x" + media().fullscreenVideo.height)));
                assertPlaying("picture in picture without background opt-in");
                assertService(true);
                controller().getTransportControls().pause();
                assertService(false);
                assertEquals("PiP Pause controls page video", "true", evaluate("document.querySelector('video').paused"));
                controller().getTransportControls().play();
                assertService(true);
                assertPlaying("PiP Play controls page video");
                capture("pip-" + (target.equals("#player") ? "light" : "dark") + ".png");
                shell("am start -W -n " + activity.getPackageName() + "/com.zmarn.once.MainActivity");
                support.until("Returning restores fullscreen", () -> !activity.isInPictureInPictureMode() && activity.hasWindowFocus(), 10);
                assertService(false);
                assertPlaying("returned from PiP");
                dismissFullscreenHelp();
                if (target.equals("#player") || !"ranchu".equals(android.os.Build.HARDWARE)) shell("input keyevent KEYCODE_BACK");
                else {
                    int mid = activity.getWindow().getDecorView().getHeight() / 2;
                    shell("input swipe 0 " + mid + " 350 " + mid + " 300");
                    // Immersive Android first reveals its hidden system bars.
                    if (plugin.video.isFullscreen()) shell("input swipe 0 " + mid + " 350 " + mid + " 300");
                }
                support.ui(() -> android.util.Log.i("OnceMediaTest", "After Back: fullscreen=" + plugin.video.isFullscreen()
                    + " size=" + plugin.surface.getWidth() + "x" + plugin.surface.getHeight() + " original=" + originalSize[0] + "x" + originalSize[1]));
                capture("after-back.png");
                support.until("Back restores the reading viewport", () -> !plugin.video.isFullscreen()
                    && plugin.surface.getWidth() == originalSize[0] && plugin.surface.getHeight() == originalSize[1], 10);
                assertEquals("Back exits DOM fullscreen", "true", evaluate("document.fullscreenElement === null"));
                assertFalse(media().isEnabled());
            }
            tapElement("#fullscreen");
            support.until("Playing fullscreen has video dimensions", () -> plugin.video.canPip(), 10);
            evaluate("document.querySelector('#media').pause(); true");
            support.until("Fullscreen video pauses", () -> !media().state.playing, 10);
            support.ui(() -> assertFalse("Paused video must not auto-enter PiP", plugin.video.canPip()));
            // Gecko may clear media-session metadata while DOM fullscreen
            // remains open. A resumed player still needs the last dimensions.
            support.ui(() -> media().onFullscreen(session(),
                (org.mozilla.geckoview.MediaSession) GeckoTestSupport.field(media(), "playing"), false, null));
            shell("input keyevent KEYCODE_HOME");
            assertFalse("Paused fullscreen stays out of PiP", activity.isInPictureInPictureMode());
            shell("am start -W -n " + activity.getPackageName() + "/com.zmarn.once.MainActivity");
            support.until("Paused fullscreen returns to the foreground", activity::hasWindowFocus, 10);
            evaluate("document.querySelector('#media').play(); true");
            assertPlaying("resumed fullscreen video");
            support.until("Resumed fullscreen regains PiP eligibility", () -> plugin.video.canPip(), 10);
            shell("input keyevent KEYCODE_HOME");
            support.until("Resumed fullscreen enters PiP again", activity::isInPictureInPictureMode, 10);
            assertPlaying("resumed fullscreen in PiP");
            shell("am start -W -n " + activity.getPackageName() + "/com.zmarn.once.MainActivity");
            support.until("Resumed PiP returns to the foreground", () -> !activity.isInPictureInPictureMode() && activity.hasWindowFocus(), 10);
            // Selecting another tab must release native fullscreen ownership.
            call(plugin::setVisible, new JSObject().put("visible", false));
            support.ui(() -> assertNull(activity.readingVideo));
        } finally {
            support.ui(() -> activity.setRequestedOrientation(orientation));
            support.ui(() -> media().setEnabled(original));
            call(plugin::close, new JSObject());
            support.ui(activity::finish);
        }
    }

    private void exercisePlayback(boolean video) throws Exception {
        Context context = instrumentation.getTargetContext();
        assertTrue("Use the emulator or the isolated Gecko test app on a physical device",
            "ranchu".equals(android.os.Build.HARDWARE) ||
            context.getPackageName().equals("com.zmarn.once.geckotest.dev"));
        assertTrue(context.getPackageName().endsWith(".dev"));
        shell("input keyevent KEYCODE_WAKEUP");
        shell("wm dismiss-keyguard");
        Intent launch = new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        activity = (MainActivity) instrumentation.startActivitySync(launch);
        instrumentation.runOnMainSync(() -> activity.getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON));
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
            int cycles = Integer.parseInt(InstrumentationRegistry.getArguments().getString("cycles", "3"));
            for (int cycle = 0; cycle < cycles; cycle++) {
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
                long foregroundDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
                while (!activity.hasWindowFocus() && System.nanoTime() < foregroundDeadline) Thread.sleep(100);
                assertTrue("Waking returns the test activity to the foreground", activity.hasWindowFocus());
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
            assertAndroidControls();
            evaluate("document.querySelector('#media').pause(); true");
            assertService(false);
            evaluate("document.querySelector('#media').play(); true");
            assertService(true);
            notificationAction("Pause");
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

    private void notificationAction(String label) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        do {
            for (android.service.notification.StatusBarNotification notification : instrumentation.getTargetContext()
                    .getSystemService(android.app.NotificationManager.class).getActiveNotifications()) {
                if (notification.getNotification().actions == null) continue;
                for (android.app.Notification.Action action : notification.getNotification().actions) {
                    if (label.contentEquals(action.title)) { action.actionIntent.send(); return; }
                }
            }
            Thread.sleep(100);
        } while (System.nanoTime() < deadline);
        fail("Playback notification supplies " + label);
    }

    private void assertAndroidControls() throws Exception {
        assertService(true);
        android.media.session.MediaController controller = controller();
        assertEquals("Once background media fixture", controller.getMetadata().getString(android.media.MediaMetadata.METADATA_KEY_TITLE));
        assertTrue("Android receives duration", controller.getMetadata().getLong(android.media.MediaMetadata.METADATA_KEY_DURATION) > 0);
        assertTrue("Android receives current position", controller.getPlaybackState().getPosition() >= 0);
        assertTrue("Android advertises seeking", (controller.getPlaybackState().getActions() & android.media.session.PlaybackState.ACTION_SEEK_TO) != 0);
        shell("cmd statusbar expand-notifications");
        Thread.sleep(1000);
        capture("media-controls.png");
        shell("cmd statusbar collapse");
        controller.getTransportControls().pause();
        assertService(false);
        Thread.sleep(300);
        assertEquals(android.media.session.PlaybackState.STATE_PAUSED, controller().getPlaybackState().getState());
        controller().getTransportControls().seekTo(2000);
        Thread.sleep(500);
        assertEquals("Android seek reaches the page", 2.0, time(), 0.25);
        shell("input keyevent KEYCODE_SLEEP");
        controller().getTransportControls().play();
        assertService(true);
        assertPlaying("Android Play while screen off");
        shell("input keyevent KEYCODE_WAKEUP");
        shell("wm dismiss-keyguard");
    }

    @Test public void youtubeLiveControls() throws Exception {
        org.junit.Assume.assumeTrue("Opt-in network smoke", "true".equals(InstrumentationRegistry.getArguments().getString("youtubeLive")));
        Context context = instrumentation.getTargetContext();
        assertEquals("ranchu", android.os.Build.HARDWARE);
        assertTrue(context.getPackageName().endsWith(".dev"));
        shell("input keyevent KEYCODE_WAKEUP");
        shell("wm dismiss-keyguard");
        activity = (MainActivity) instrumentation.startActivitySync(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        plugin = (InAppBrowserSurfacePlugin) activity.getBridge().getPlugin("InAppBrowserSurface").getInstance();
        boolean original = media().isEnabled();
        try {
            call(plugin::close, new JSObject());
            instrumentation.runOnMainSync(() -> media().setEnabled(true));
            call(plugin::open, new JSObject().put("url", "https://m.youtube.com/watch?v=aqz-KE-bpKQ").put("visible", true)
                .put("bounds", new JSObject().put("x", 0).put("y", 100).put("width", 400).put("height", 650)));
            // Test-only permission: exercise transport controls independently of autoplay UI.
            instrumentation.runOnMainSync(() -> session().setPermissionDelegate(new GeckoSession.PermissionDelegate() {
                @Override public GeckoResult<Integer> onContentPermissionRequest(GeckoSession source, ContentPermission permission) {
                    return GeckoResult.fromValue(permission.permission == PERMISSION_AUTOPLAY_AUDIBLE || permission.permission == PERMISSION_AUTOPLAY_INAUDIBLE
                        ? ContentPermission.VALUE_ALLOW : ContentPermission.VALUE_DENY);
                }
            }));
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
            while (field("bridgePort") == null && System.nanoTime() < deadline) Thread.sleep(200);
            assertNotNull("YouTube document bridge", field("bridgePort"));
            Thread.sleep(5000);
            android.util.Log.i("OnceMediaTest", "YouTube page: " + evaluate("document.title"));
            evaluate("Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === 'Reject all')?.click(); true");
            Thread.sleep(2000);
            assertEquals("YouTube video element", "true", evaluate("!!document.querySelector('video')"));
            tapVideo();
            evaluate("document.querySelector('video').play().catch(error => document.body.dataset.playError = String(error)); true");
            Thread.sleep(4000);
            android.util.Log.i("OnceMediaTest", "YouTube play error: " + evaluate("document.body.dataset.playError || null"));
            assertEquals("YouTube allows playback", "false", evaluate("document.querySelector('video').paused"));
            deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
            while (!"true".equals(evaluate("document.querySelector('video').currentTime > 0.5 && document.querySelector('video').readyState >= 2"))
                    && System.nanoTime() < deadline) Thread.sleep(500);
            android.util.Log.i("OnceMediaTest", "YouTube stream: " + evaluate("(() => { const v=document.querySelector('video'); return {time:v.currentTime,duration:v.duration,ready:v.readyState,error:v.error?.message,ui:document.body.innerText.slice(-700)}; })()"));
            assertService(true);
            android.media.session.MediaController controller = controller();
            android.util.Log.i("OnceMediaTest", "YouTube Android title: " + controller.getMetadata().getString(android.media.MediaMetadata.METADATA_KEY_TITLE)
                + "; artist: " + controller.getMetadata().getString(android.media.MediaMetadata.METADATA_KEY_ARTIST)
                + "; duration: " + controller.getMetadata().getLong(android.media.MediaMetadata.METADATA_KEY_DURATION));
            assertTrue(controller.getMetadata().getLong(android.media.MediaMetadata.METADATA_KEY_DURATION) > 0);
            shell("cmd statusbar expand-notifications");
            Thread.sleep(1000);
            capture("youtube-controls.png");
            shell("cmd statusbar collapse");
            controller.getTransportControls().pause();
            assertService(false);
            controller().getTransportControls().seekTo(30000);
            Thread.sleep(1000);
            assertEquals(30, Double.parseDouble(evaluate("document.querySelector('video').currentTime")), 1);
            shell("input keyevent KEYCODE_SLEEP");
            controller().getTransportControls().play();
            assertService(true);
            deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(15);
            while (Double.parseDouble(evaluate("document.querySelector('video').currentTime")) <= 31
                    && System.nanoTime() < deadline) Thread.sleep(500);
            String resumed = evaluate("(() => { const v=document.querySelector('video'); return {time:v.currentTime,paused:v.paused,ready:v.readyState,error:v.error?.message}; })()");
            android.util.Log.i("OnceMediaTest", "YouTube screen-off resume: " + resumed);
            assertTrue("YouTube screen-off resume: " + resumed, Double.parseDouble(evaluate("document.querySelector('video').currentTime")) > 31);
        } finally {
            shell("input keyevent KEYCODE_WAKEUP");
            shell("wm dismiss-keyguard");
            instrumentation.runOnMainSync(() -> media().setEnabled(original));
            call(plugin::close, new JSObject());
            instrumentation.runOnMainSync(activity::finish);
        }
    }

    @Test public void youtubeFullscreenEntersPip() throws Exception {
        org.junit.Assume.assumeTrue("Opt-in network smoke", "true".equals(InstrumentationRegistry.getArguments().getString("youtubeLive")));
        assertEquals("Use the local emulator", "ranchu", android.os.Build.HARDWARE);
        GeckoTestSupport support = new GeckoTestSupport();
        support.start(); activity = support.activity; plugin = support.plugin;
        boolean original = media().isEnabled();
        try {
            call(plugin::close, new JSObject());
            call(plugin::open, new JSObject().put("url", "https://m.youtube.com/watch?v=aqz-KE-bpKQ").put("visible", true)
                .put("bounds", new JSObject().put("x", 0).put("y", 100).put("width", 400).put("height", 650)));
            support.ui(() -> {
                media().setEnabled(false);
                session().setPermissionDelegate(new GeckoSession.PermissionDelegate() {
                    @Override public GeckoResult<Integer> onContentPermissionRequest(GeckoSession source, ContentPermission permission) {
                        return GeckoResult.fromValue(permission.permission == PERMISSION_AUTOPLAY_AUDIBLE || permission.permission == PERMISSION_AUTOPLAY_INAUDIBLE
                            ? ContentPermission.VALUE_ALLOW : ContentPermission.VALUE_DENY);
                    }
                });
            });
            support.until("YouTube document bridge", () -> field("bridgePort") != null, 35);
            Thread.sleep(5000);
            evaluate("Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Reject all')?.click(); true");
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
            while (!"true".equals(evaluate("!!document.querySelector('video')")) && System.nanoTime() < deadline) Thread.sleep(300);
            assertEquals("YouTube video element", "true", evaluate("!!document.querySelector('video')"));
            tapVideo();
            evaluate("document.querySelector('video').play().catch(e=>document.body.dataset.playError=String(e)); true");
            deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(35);
            while (!"true".equals(evaluate("document.querySelector('video').currentTime>1 && document.querySelector('video').readyState>=2")) && System.nanoTime() < deadline) Thread.sleep(300);
            String stream = evaluate("(() => {const v=document.querySelector('video'); return {time:v.currentTime,paused:v.paused,ready:v.readyState,error:v.error?.message,playError:document.body.dataset.playError}})()");
            android.util.Log.i("OnceMediaTest", "YouTube PiP stream: " + stream);
            assertEquals("YouTube stream must load: " + stream, "true", evaluate("document.querySelector('video').currentTime>1 && document.querySelector('video').readyState>=2"));
            tapVideo();
            capture("youtube-inline.png");
            // A real tap supplies fullscreen's user activation, using YouTube's own control.
            evaluate("""
                const buttons = Array.from(document.querySelectorAll('.ytp-fullscreen-button, button.fullscreen-icon, button[aria-label*="full screen" i], button[aria-label*="fullscreen" i]'));
                const button = buttons.find(b => b.getBoundingClientRect().width > 0 && getComputedStyle(b).visibility !== 'hidden');
                if (button) button.id='once-fullscreen';
                true
                """);
            assertEquals("YouTube fullscreen control", "true", evaluate("!!document.querySelector('#once-fullscreen')"));
            tapElement("#once-fullscreen");
            android.util.Log.i("OnceMediaTest", "YouTube fullscreen: " + evaluate("({fullscreen:!!document.fullscreenElement,paused:document.querySelector('video').paused,buttons:Array.from(document.querySelectorAll('button[aria-label]')).map(b=>b.getAttribute('aria-label')).filter(s=>/full/i.test(s))})"));
            capture("youtube-fullscreen-request.png");
            support.until("YouTube fullscreen must be eligible for PiP", () -> plugin.video.canPip(), 15);
            dismissFullscreenHelp();
            capture("youtube-fullscreen.png");
            double before = Double.parseDouble(evaluate("document.querySelector('video').currentTime"));
            shell("input keyevent KEYCODE_HOME");
            support.until("YouTube enters Android PiP", activity::isInPictureInPictureMode, 10);
            Thread.sleep(2500);
            assertTrue("YouTube continues in PiP", Double.parseDouble(evaluate("document.querySelector('video').currentTime")) > before + 1);
            capture("youtube-pip.png");
            shell("am start -W -n " + activity.getPackageName() + "/com.zmarn.once.MainActivity");
            support.until("YouTube returns from PiP", () -> !activity.isInPictureInPictureMode() && activity.hasWindowFocus(), 10);
            dismissFullscreenHelp();
            shell("input keyevent KEYCODE_BACK");
            support.until("YouTube exits fullscreen", () -> !plugin.video.isFullscreen(), 10);
            assertFalse(media().isEnabled());
        } finally {
            shell("am start -W -n " + activity.getPackageName() + "/com.zmarn.once.MainActivity");
            support.ui(() -> media().setEnabled(original));
            call(plugin::close, new JSObject());
            support.ui(activity::finish);
        }
    }

}
