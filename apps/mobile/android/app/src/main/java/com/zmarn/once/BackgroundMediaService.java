package com.zmarn.once;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.BroadcastReceiver;
import android.content.IntentFilter;
import android.graphics.drawable.Icon;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.IBinder;
import android.os.PowerManager;
import android.media.session.PlaybackState;
import org.mozilla.geckoview.MediaSession;

/** Keeps ongoing Gecko playback alive without keeping the screen or reading view on. */
public final class BackgroundMediaService extends Service {
    private static final String CHANNEL = "background-media";
    private static final String PAUSE = "com.zmarn.once.PAUSE_BACKGROUND_MEDIA";
    private static final int NOTIFICATION = 4101;
    // Once owns one reading session. Access is confined to the Android main thread.
    private static MediaSession playing;
    private PowerManager.WakeLock wakeLock;
    private android.media.session.MediaSession controls;
    private AudioManager audioManager;
    private AudioFocusRequest audioFocus;
    private boolean focusRequested;
    private final BroadcastReceiver unplugged = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) { pause(); }
    };

    static void start(Context context, MediaSession media) {
        if (playing == media) return;
        playing = media;
        context.startForegroundService(new Intent(context, BackgroundMediaService.class));
    }

    static void stop(Context context) {
        playing = null;
        context.stopService(new Intent(context, BackgroundMediaService.class));
    }

    @Override public void onCreate() {
        super.onCreate();
        getSystemService(NotificationManager.class).createNotificationChannel(
            new NotificationChannel(CHANNEL, "Background playback", NotificationManager.IMPORTANCE_LOW));
        controls = new android.media.session.MediaSession(this, "Once reading media");
        controls.setCallback(new android.media.session.MediaSession.Callback() {
            @Override public void onPause() { pause(); }
            @Override public void onStop() { pause(); }
        });
        controls.setPlaybackState(new PlaybackState.Builder()
            .setActions(PlaybackState.ACTION_PAUSE | PlaybackState.ACTION_STOP)
            .setState(PlaybackState.STATE_PLAYING, PlaybackState.PLAYBACK_POSITION_UNKNOWN, 1).build());
        controls.setActive(true);
        audioManager = getSystemService(AudioManager.class);
        audioFocus = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
            .setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build())
            .setOnAudioFocusChangeListener(change -> {
                if (change < 0) pause();
            }).build();
        androidx.core.content.ContextCompat.registerReceiver(this, unplugged,
            new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY), androidx.core.content.ContextCompat.RECEIVER_NOT_EXPORTED);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        // Promote even if playback stopped while Android was scheduling this start.
        PendingIntent open = PendingIntent.getActivity(this, 0,
            new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE);
        PendingIntent pause = PendingIntent.getService(this, 1,
            new Intent(this, BackgroundMediaService.class).setAction(PAUSE), PendingIntent.FLAG_IMMUTABLE);
        Notification notification = new Notification.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle("Once background playback")
            .setContentText("Audio and video can keep playing while Once is in the background")
            .setContentIntent(open).setOngoing(true).setOnlyAlertOnce(true)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .addAction(new Notification.Action.Builder(Icon.createWithResource(this, android.R.drawable.ic_media_pause), "Pause", pause).build())
            .setStyle(new Notification.MediaStyle().setMediaSession(controls.getSessionToken()).setShowActionsInCompactView(0))
            .build();
        startForeground(NOTIFICATION, notification);
        if (intent != null && PAUSE.equals(intent.getAction())) pause();
        if (playing == null) {
            stopSelf(startId);
            return START_NOT_STICKY;
        }
        if (!focusRequested) {
            focusRequested = true;
            if (audioManager.requestAudioFocus(audioFocus) != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
                pause();
                return START_NOT_STICKY;
            }
        }
        if (wakeLock == null) {
            wakeLock = getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Once:BackgroundMedia");
            wakeLock.acquire();
        }
        return START_NOT_STICKY;
    }

    private void pause() {
        if (playing != null) playing.pause();
        playing = null;
        stopSelf();
    }

    @Override public void onTaskRemoved(Intent rootIntent) { pause(); }

    @Override public void onDestroy() {
        unregisterReceiver(unplugged);
        if (focusRequested) audioManager.abandonAudioFocusRequest(audioFocus);
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (controls != null) controls.release();
        stopForeground(STOP_FOREGROUND_REMOVE);
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
