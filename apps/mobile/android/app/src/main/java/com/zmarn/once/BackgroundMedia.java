package com.zmarn.once;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;
import android.widget.Toast;
import org.mozilla.geckoview.GeckoSession;
import org.mozilla.geckoview.MediaSession;

/** The reading session's persisted playback policy, independent of view visibility. */
final class BackgroundMedia implements MediaSession.Delegate {
    private final Context context;
    private final SharedPreferences preferences;
    private GeckoSession session;
    private MediaSession playing;
    private boolean active = true;

    BackgroundMedia(Context context) {
        this.context = context.getApplicationContext();
        preferences = this.context.getSharedPreferences("reading-media", Context.MODE_PRIVATE);
    }

    boolean isEnabled() { return preferences.getBoolean("background-playback", false); }

    void attach(GeckoSession session) {
        reset();
        this.session = session;
        session.getSettings().setSuspendMediaWhenInactive(!isEnabled());
        session.setMediaSessionDelegate(this);
    }

    void setEnabled(boolean enabled) {
        preferences.edit().putBoolean("background-playback", enabled).apply();
        if (session != null) session.getSettings().setSuspendMediaWhenInactive(!enabled);
        if (!enabled && !active && playing != null) playing.pause();
        updateService();
    }

    void setActive(boolean active) {
        this.active = active;
        if (session != null && session.isOpen()) session.setActive(active);
        if (!active && !isEnabled() && playing != null) playing.pause();
    }

    private void updateService() {
        if (!isEnabled() || playing == null) {
            BackgroundMediaService.stop(context);
            return;
        }
        try {
            BackgroundMediaService.start(context, playing);
        } catch (RuntimeException error) {
            Log.e("OnceMedia", "Could not start background playback", error);
            playing.pause();
            BackgroundMediaService.stop(context);
            Toast.makeText(context, "Background playback could not start. Reopen Once and try again.", Toast.LENGTH_LONG).show();
        }
    }

    @Override public void onPlay(GeckoSession source, MediaSession media) {
        if (source != session) return;
        playing = media;
        if (!active && !isEnabled()) { media.pause(); return; }
        updateService();
    }

    @Override public void onPause(GeckoSession source, MediaSession media) { stopped(source, media); }
    @Override public void onStop(GeckoSession source, MediaSession media) { stopped(source, media); }
    @Override public void onDeactivated(GeckoSession source, MediaSession media) { stopped(source, media); }

    private void stopped(GeckoSession source, MediaSession media) {
        if (source != session || playing != media) return;
        playing = null;
        BackgroundMediaService.stop(context);
    }

    void reset() {
        playing = null;
        BackgroundMediaService.stop(context);
    }

    void detach() {
        if (session != null) session.setMediaSessionDelegate(null);
        session = null;
        reset();
    }
}
