package com.zmarn.once;

import android.app.ActivityManager;
import android.app.Instrumentation;
import android.app.Notification;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaMetadata;
import android.media.session.MediaController;
import android.media.session.PlaybackState;
import android.service.notification.StatusBarNotification;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/** Reader speech drives Android media controls without Gecko media or the background preference. */
@RunWith(AndroidJUnit4.class)
public class ReaderMediaSessionTest {
    private final Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
    private final Context context = instrumentation.getTargetContext();
    private final BlockingQueue<String> commands = new LinkedBlockingQueue<>();
    private ReaderMediaSessionPlugin plugin;

    @Test public void speechControlsReportCommandsAndRelease() throws Exception {
        assertEquals("Run against the emulator", "ranchu", android.os.Build.HARDWARE);
        assertTrue(context.getPackageName().endsWith(".dev"));
        shell("input keyevent KEYCODE_WAKEUP");
        shell("wm dismiss-keyguard");
        MainActivity activity = (MainActivity) instrumentation.startActivitySync(
            new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        plugin = (ReaderMediaSessionPlugin) activity.getBridge().getPlugin("ReaderMediaSession").getInstance();
        boolean original = new BackgroundMedia(context).isEnabled();
        Call listener = new Call(new JSObject().put("eventName", "command")) {
            @Override public void resolve(JSObject result) { commands.add(result.getString("action")); }
        };
        instrumentation.runOnMainSync(() -> plugin.addListener(listener));
        try {
            instrumentation.runOnMainSync(() -> new BackgroundMedia(context).setEnabled(false));
            call(plugin::update, speech(false, 0));
            assertService(true);
            MediaController controller = controller();
            MediaMetadata metadata = controller.getMetadata();
            assertEquals("Fixture article", metadata.getString(MediaMetadata.METADATA_KEY_TITLE));
            assertEquals("example.com", metadata.getString(MediaMetadata.METADATA_KEY_ARTIST));
            assertEquals("Paragraph 1 of 3", metadata.getString(MediaMetadata.METADATA_KEY_ALBUM));
            assertFalse("No fake timeline", metadata.containsKey(MediaMetadata.METADATA_KEY_DURATION));
            PlaybackState state = controller.getPlaybackState();
            assertEquals(PlaybackState.STATE_PLAYING, state.getState());
            assertEquals(0, state.getActions() & (PlaybackState.ACTION_SKIP_TO_PREVIOUS | PlaybackState.ACTION_SEEK_TO));
            assertNotEquals(0, state.getActions() & PlaybackState.ACTION_SKIP_TO_NEXT);

            controller.getTransportControls().skipToNext();
            assertCommand("next");
            controller.getTransportControls().pause();
            assertCommand("pause");

            call(plugin::update, speech(true, 1));
            assertService(false);
            state = controller().getPlaybackState();
            assertEquals("Paused speech keeps its controls", PlaybackState.STATE_PAUSED, state.getState());
            assertNotEquals(0, state.getActions() & PlaybackState.ACTION_SKIP_TO_PREVIOUS);
            notificationAction("Play");
            assertCommand("play");

            call(plugin::update, speech(false, 2));
            assertService(true);
            assertEquals(0, controller().getPlaybackState().getActions() & PlaybackState.ACTION_SKIP_TO_NEXT);
            // Another owner releasing must not take down reader controls.
            BackgroundMediaService.Owner other = new BackgroundMediaService.Owner() {
                @Override public ReadingMediaState mediaState() { return new ReadingMediaState(); }
                @Override public void command(String action, long position) {}
            };
            instrumentation.runOnMainSync(() -> BackgroundMediaService.release(context, other));
            assertService(true);

            AudioManager audio = context.getSystemService(AudioManager.class);
            AudioFocusRequest focus = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                .setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).build())
                .setOnAudioFocusChangeListener(change -> {}).build();
            assertEquals(AudioManager.AUDIOFOCUS_REQUEST_GRANTED, audio.requestAudioFocus(focus));
            assertCommand("pause");
            audio.abandonAudioFocusRequest(focus);

            notificationAction("Stop");
            assertCommand("stop");
            assertService(false);
            call(plugin::clear, new JSObject());
            assertNoControls();

            call(plugin::update, speech(false, 0));
            assertService(true);
            call(plugin::clear, new JSObject());
            assertService(false);
            assertNoControls();
        } finally {
            call(plugin::clear, new JSObject());
            instrumentation.runOnMainSync(() -> plugin.removeAllListeners(new Call(new JSObject())));
            instrumentation.runOnMainSync(() -> new BackgroundMedia(context).setEnabled(original));
            instrumentation.runOnMainSync(activity::finish);
        }
    }

    private static JSObject speech(boolean paused, int index) {
        return new JSObject().put("title", "Fixture article").put("subtitle", "example.com")
            .put("playing", true).put("paused", paused).put("index", index).put("count", 3);
    }

    private void assertCommand(String expected) throws Exception {
        assertEquals(expected, commands.poll(5, TimeUnit.SECONDS));
    }

    private MediaController controller() throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        do {
            for (StatusBarNotification notification : context.getSystemService(NotificationManager.class).getActiveNotifications()) {
                android.media.session.MediaSession.Token token = notification.getNotification().extras.getParcelable(Notification.EXTRA_MEDIA_SESSION);
                if (token != null) return new MediaController(context, token);
            }
            Thread.sleep(100);
        } while (System.nanoTime() < deadline);
        throw new AssertionError("No Android media controls");
    }

    private void assertNoControls() throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (context.getSystemService(NotificationManager.class).getActiveNotifications().length > 0) {
            if (System.nanoTime() > deadline) fail("Reader media notification remains");
            Thread.sleep(100);
        }
    }

    private void notificationAction(String label) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        do {
            for (StatusBarNotification notification : context.getSystemService(NotificationManager.class).getActiveNotifications()) {
                if (notification.getNotification().actions == null) continue;
                for (Notification.Action action : notification.getNotification().actions) {
                    if (label.contentEquals(action.title)) { action.actionIntent.send(); return; }
                }
            }
            Thread.sleep(100);
        } while (System.nanoTime() < deadline);
        fail("Reader notification supplies " + label);
    }

    private void assertService(boolean expected) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        boolean running;
        do {
            running = context.getSystemService(ActivityManager.class).getRunningServices(100).stream()
                .anyMatch(service -> BackgroundMediaService.class.getName().equals(service.service.getClassName()) && service.foreground);
            if (running == expected) return;
            Thread.sleep(100);
        } while (System.nanoTime() < deadline);
        assertEquals("Foreground playback service", expected, running);
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
        operation.accept(call);
        assertTrue("Plugin call timed out", call.done.await(10, TimeUnit.SECONDS));
        assertNull(call.error, call.error);
        return call;
    }

    private static class Call extends PluginCall {
        final CountDownLatch done = new CountDownLatch(1);
        volatile String error;
        Call(JSObject data) { super(null, "ReaderMediaSession", "test", "test", data); }
        @Override public void resolve() { done.countDown(); }
        @Override public void resolve(JSObject result) { done.countDown(); }
        @Override public void reject(String message) { error = message; done.countDown(); }
        @Override public void reject(String message, Exception cause) { reject(message + ": " + cause); }
    }
}
