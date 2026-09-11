package com.zmarn.once;

import android.app.NotificationManager;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;

/** Foreground only while playing; paused controls remain available without a wake lock. */
public final class BackgroundMediaService extends Service {
    static final int NOTIFICATION = 4101;
    private static BackgroundMedia current;
    private static BackgroundMediaService instance;
    private static boolean starting;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable expire = () -> stop(this);
    private PowerManager.WakeLock wakeLock;
    private android.media.session.MediaSession controls;
    private AudioManager audioManager;
    private AudioFocusRequest audioFocus;
    private boolean focusRequested, foreground, expiryScheduled;
    private final BroadcastReceiver unplugged = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) { dispatch("pause", 0); }
    };

    static void update(Context context, BackgroundMedia media) {
        current = media;
        if (instance != null) instance.refresh();
        else if (media.state.playing && !starting) {
            starting = true;
            try { context.startForegroundService(new Intent(context, BackgroundMediaService.class)); }
            catch (RuntimeException error) { starting = false; throw error; }
        }
    }

    static void stop(Context context) {
        current = null;
        starting = false;
        context.stopService(new Intent(context, BackgroundMediaService.class));
        context.getSystemService(NotificationManager.class).cancel(NOTIFICATION);
    }

    @Override public void onCreate() {
        super.onCreate();
        instance = this;
        starting = false;
        ReadingMediaNotification.createChannel(this);
        controls = new android.media.session.MediaSession(this, "Once reading media");
        controls.setCallback(new android.media.session.MediaSession.Callback() {
            @Override public void onPlay() { dispatch("play", 0); }
            @Override public void onPause() { dispatch("pause", 0); }
            @Override public void onStop() { dispatch("pause", 0); stop(BackgroundMediaService.this); }
            @Override public void onSeekTo(long position) { dispatch("seek", position); }
            @Override public void onRewind() { dispatch("back", 0); }
            @Override public void onFastForward() { dispatch("forward", 0); }
            @Override public void onSkipToNext() { dispatch("next", 0); }
            @Override public void onSkipToPrevious() { dispatch("previous", 0); }
            @Override public void onCustomAction(String action, android.os.Bundle extras) {
                if ("back".equals(action) || "forward".equals(action)) dispatch(action, 0);
            }
        });
        controls.setActive(true);
        audioManager = getSystemService(AudioManager.class);
        audioFocus = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
            .setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build())
            .setOnAudioFocusChangeListener(change -> { if (change < 0) dispatch("pause", 0); }).build();
        androidx.core.content.ContextCompat.registerReceiver(this, unplugged,
            new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY), androidx.core.content.ContextCompat.RECEIVER_NOT_EXPORTED);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        // Fulfil a pending foreground start even if playback stopped before delivery.
        ReadingMediaState state = current == null ? new ReadingMediaState() : current.state;
        startForeground(NOTIFICATION, ReadingMediaNotification.build(this, controls, state));
        foreground = true;
        if (current == null) { stopSelf(startId); return START_NOT_STICKY; }
        if (intent != null && intent.getAction() != null) {
            if ("stop".equals(intent.getAction())) { dispatch("pause", 0); stop(this); return START_NOT_STICKY; }
            dispatch(intent.getAction(), 0);
        }
        refresh();
        return START_NOT_STICKY;
    }

    private void dispatch(String action, long position) {
        if (current != null) current.command(action, position);
    }

    // MediaStyle notifications with an active MediaSession are exempt from POST_NOTIFICATIONS.
    // https://developer.android.com/develop/ui/views/notifications/notification-permission#exemptions
    @android.annotation.SuppressLint("NotificationPermission")
    private void refresh() {
        if (current == null || controls == null) return;
        ReadingMediaState state = current.state;
        controls.setMetadata(state.metadata());
        controls.setPlaybackState(state.playbackState());
        android.app.Notification notification = ReadingMediaNotification.build(this, controls, state);
        if (state.playing) {
            handler.removeCallbacks(expire);
            expiryScheduled = false;
            if (!foreground) { startForeground(NOTIFICATION, notification); foreground = true; }
            else getSystemService(NotificationManager.class).notify(NOTIFICATION, notification);
            if (!focusRequested) {
                focusRequested = true;
                if (audioManager.requestAudioFocus(audioFocus) != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
                    dispatch("pause", 0);
                    releasePlayback();
                    return;
                }
            }
            if (wakeLock == null) {
                wakeLock = getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Once:BackgroundMedia");
                wakeLock.acquire();
            }
        } else {
            releasePlayback();
            if (foreground) { stopForeground(STOP_FOREGROUND_DETACH); foreground = false; }
            getSystemService(NotificationManager.class).notify(NOTIFICATION, notification);
            if (!expiryScheduled) {
                expiryScheduled = true;
                handler.postDelayed(expire, 5 * 60 * 1000);
            }
        }
    }

    private void releasePlayback() {
        if (focusRequested) { focusRequested = false; audioManager.abandonAudioFocusRequest(audioFocus); }
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        wakeLock = null;
    }

    @Override public void onTaskRemoved(Intent rootIntent) { dispatch("pause", 0); stop(this); }

    @Override public void onDestroy() {
        instance = null;
        handler.removeCallbacksAndMessages(null);
        unregisterReceiver(unplugged);
        releasePlayback();
        if (controls != null) controls.release();
        stopForeground(STOP_FOREGROUND_REMOVE);
        getSystemService(NotificationManager.class).cancel(NOTIFICATION);
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
