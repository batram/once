package com.zmarn.once;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.graphics.drawable.Icon;
import android.media.session.MediaSession;

final class ReadingMediaNotification {
    private static final String CHANNEL = "background-media";

    static void createChannel(Context context) {
        context.getSystemService(NotificationManager.class).createNotificationChannel(
            new NotificationChannel(CHANNEL, "Background playback", NotificationManager.IMPORTANCE_LOW));
    }

    static Notification build(Context context, MediaSession controls, ReadingMediaState state) {
        PendingIntent open = PendingIntent.getActivity(context, 0,
            new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder notification = new Notification.Builder(context, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_media_play).setContentTitle(state.title)
            .setContentText(state.artist.isEmpty() ? "Once reading media" : state.artist)
            .setSubText(state.album.isEmpty() ? null : state.album)
            .setContentIntent(open).setOngoing(state.playing).setOnlyAlertOnce(true)
            .setDeleteIntent(command(context, "stop"))
            .setVisibility(Notification.VISIBILITY_PUBLIC);
        if (state.artwork != null) notification.setLargeIcon(state.artwork);
        if (state.canSeek()) notification.addAction(action(context, "back", "Back 10 seconds", android.R.drawable.ic_media_rew));
        notification.addAction(action(context, state.playing ? "pause" : "play", state.playing ? "Pause" : "Play",
            state.playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play));
        if (state.canSeek()) notification.addAction(action(context, "forward", "Forward 10 seconds", android.R.drawable.ic_media_ff));
        notification.setStyle(new Notification.MediaStyle().setMediaSession(controls.getSessionToken())
            .setShowActionsInCompactView(state.canSeek() ? new int[] {0, 1, 2} : new int[] {0}));
        return notification.build();
    }

    private static PendingIntent command(Context context, String action) {
        return PendingIntent.getService(context, 0, new Intent(context, BackgroundMediaService.class).setAction(action), PendingIntent.FLAG_IMMUTABLE);
    }

    private static Notification.Action action(Context context, String action, String title, int icon) {
        return new Notification.Action.Builder(Icon.createWithResource(context, icon), title, command(context, action)).build();
    }
}
