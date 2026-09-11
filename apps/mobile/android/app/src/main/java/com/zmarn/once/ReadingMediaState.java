package com.zmarn.once;

import android.graphics.Bitmap;
import android.media.MediaMetadata;
import android.media.session.PlaybackState;
import android.os.SystemClock;
import org.mozilla.geckoview.MediaSession;

/** Android advances the progress bar between Gecko updates. */
final class ReadingMediaState {
    String title = "Once reading media", artist = "", album = "";
    Bitmap artwork;
    long duration = -1, position = PlaybackState.PLAYBACK_POSITION_UNKNOWN;
    long updatedAt = SystemClock.elapsedRealtime(), features;
    double rate = 1;
    boolean playing, pageSeekable;

    void position(double seconds, double length, double speed) {
        duration = Double.isFinite(length) && length > 0 ? (long) (length * 1000) : -1;
        position = Double.isFinite(seconds) && seconds >= 0 ? (long) (seconds * 1000) : PlaybackState.PLAYBACK_POSITION_UNKNOWN;
        if (duration > 0 && position > duration) position = duration;
        rate = Double.isFinite(speed) && speed > 0 ? speed : 1;
        updatedAt = SystemClock.elapsedRealtime();
    }

    long positionNow() {
        if (position < 0) return position;
        long value = position + (playing ? (long) ((SystemClock.elapsedRealtime() - updatedAt) * rate) : 0);
        return duration > 0 ? Math.min(value, duration) : value;
    }

    void playing(boolean value) {
        position = positionNow();
        updatedAt = SystemClock.elapsedRealtime();
        playing = value;
    }

    boolean supports(long feature) { return (features & feature) != 0; }
    boolean canSeek() { return duration > 0 && (pageSeekable || supports(MediaSession.Feature.SEEK_TO)); }

    MediaMetadata metadata() {
        MediaMetadata.Builder result = new MediaMetadata.Builder()
            .putString(MediaMetadata.METADATA_KEY_TITLE, title)
            .putString(MediaMetadata.METADATA_KEY_ARTIST, artist)
            .putString(MediaMetadata.METADATA_KEY_ALBUM, album);
        if (duration > 0) result.putLong(MediaMetadata.METADATA_KEY_DURATION, duration);
        if (artwork != null) result.putBitmap(MediaMetadata.METADATA_KEY_ART, artwork);
        return result.build();
    }

    PlaybackState playbackState() {
        long actions = PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE | PlaybackState.ACTION_PLAY_PAUSE | PlaybackState.ACTION_STOP;
        if (canSeek()) actions |= PlaybackState.ACTION_SEEK_TO | PlaybackState.ACTION_REWIND | PlaybackState.ACTION_FAST_FORWARD;
        if (supports(MediaSession.Feature.NEXT_TRACK)) actions |= PlaybackState.ACTION_SKIP_TO_NEXT;
        if (supports(MediaSession.Feature.PREVIOUS_TRACK)) actions |= PlaybackState.ACTION_SKIP_TO_PREVIOUS;
        PlaybackState.Builder result = new PlaybackState.Builder().setActions(actions)
            .setState(playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED, positionNow(), playing ? (float) rate : 0);
        if (canSeek()) {
            result.addCustomAction("back", "Back 10 seconds", android.R.drawable.ic_media_rew);
            result.addCustomAction("forward", "Forward 10 seconds", android.R.drawable.ic_media_ff);
        }
        return result.build();
    }
}
