package com.zmarn.once;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.graphics.drawable.Icon;
import android.media.session.MediaSession;
import java.util.ArrayList;
import java.util.List;
import org.mozilla.geckoview.MediaSession.Feature;

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
        boolean seek = state.canSeek();
        List<Notification.Action> actions = new ArrayList<>();
        List<Integer> compact = new ArrayList<>();
        // Compact view fits three: seek controls for page media, otherwise track skips.
        if (state.supports(Feature.PREVIOUS_TRACK)) add(actions, compact, !seek, action(context, "previous", "Previous", android.R.drawable.ic_media_previous));
        if (seek) add(actions, compact, true, action(context, "back", "Back 10 seconds", android.R.drawable.ic_media_rew));
        add(actions, compact, true, action(context, state.playing ? "pause" : "play", state.playing ? "Pause" : "Play",
            state.playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play));
        if (seek) add(actions, compact, true, action(context, "forward", "Forward 10 seconds", android.R.drawable.ic_media_ff));
        if (state.supports(Feature.NEXT_TRACK)) add(actions, compact, !seek, action(context, "next", "Next", android.R.drawable.ic_media_next));
        if (state.stoppable) add(actions, compact, false, action(context, "stop", "Stop", android.R.drawable.ic_menu_close_clear_cancel));
        for (Notification.Action action : actions) notification.addAction(action);
        notification.setStyle(new Notification.MediaStyle().setMediaSession(controls.getSessionToken())
            .setShowActionsInCompactView(compact.stream().mapToInt(Integer::intValue).toArray()));
        return notification.build();
    }

    private static void add(List<Notification.Action> actions, List<Integer> compact, boolean compacted, Notification.Action action) {
        if (compacted) compact.add(actions.size());
        actions.add(action);
    }

    private static PendingIntent command(Context context, String action) {
        return PendingIntent.getService(context, 0, new Intent(context, BackgroundMediaService.class).setAction(action), PendingIntent.FLAG_IMMUTABLE);
    }

    private static Notification.Action action(Context context, String action, String title, int icon) {
        return new Notification.Action.Builder(Icon.createWithResource(context, icon), title, command(context, action)).build();
    }
}
