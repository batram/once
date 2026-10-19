package com.zmarn.once;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;
import android.widget.Toast;
import java.util.function.Consumer;
import org.json.JSONObject;

/**
 * The reading page's persisted playback policy, independent of view visibility,
 * fed by the page's own media reports (LiteMediaObserver) in place of Gecko's
 * MediaSession. Same preference as the GeckoView app: "reading-media" /
 * "background-playback".
 */
final class LiteBackgroundMedia implements BackgroundMediaService.Owner, BackgroundPlayback {
    private final Context context;
    private final SharedPreferences preferences;
    private boolean active = true;
    private boolean inPictureInPicture;
    private Consumer<JSONObject> page;
    private String pageUrl;
    ReadingMediaState state = new ReadingMediaState();
    // Observed for every tab, whether or not background playback is enabled.
    Consumer<Boolean> playingChanged;
    Runnable presentationChanged;
    private boolean reportedPlaying;
    int videoWidth, videoHeight;

    LiteBackgroundMedia(Context context) {
        this.context = context.getApplicationContext();
        preferences = this.context.getSharedPreferences("reading-media", Context.MODE_PRIVATE);
    }

    @Override public boolean isEnabled() { return preferences.getBoolean("background-playback", false); }
    private boolean allowsBackground() { return isEnabled() || inPictureInPicture; }
    boolean keepsPlaying() { return allowsBackground() && state.playing; }

    void setPictureInPicture(boolean enabled) {
        inPictureInPicture = enabled;
        if (!allowsBackground() && !active && state.playing) send("pause", 0);
        updateService();
    }

    @Override public void setEnabled(boolean enabled) {
        preferences.edit().putBoolean("background-playback", enabled).apply();
        if (!allowsBackground() && !active && state.playing) send("pause", 0);
        updateService();
    }

    /** The page is on screen in a resumed activity; hidden otherwise. */
    void setActive(boolean active) {
        this.active = active;
        if (!active && !allowsBackground() && state.playing) send("pause", 0);
    }

    /** The current document reports now; its predecessor's media are gone. */
    void attachPage(Consumer<JSONObject> sender) {
        page = sender;
        pageUrl = null;
        state.pageSeekable = false;
    }

    void detach() {
        page = null;
        inPictureInPicture = false;
        reset();
    }

    void reset() {
        pageUrl = null;
        state = new ReadingMediaState();
        videoWidth = videoHeight = 0;
        BackgroundMediaService.release(context, this);
        reportPlaying();
    }

    void pageSnapshot(JSONObject snapshot) {
        String url = snapshot.optString("url", "");
        if (!LiteMediaObserver.reports(url)) return;
        boolean playing = snapshot.optBoolean("playing");
        if (playing != state.playing) state.playing(playing);
        pageUrl = url;
        state.pageSeekable = snapshot.optBoolean("seekable");
        state.features = state.pageSeekable ? ReadingMediaState.Feature.SEEK_TO : 0;
        String title = snapshot.optString("title", "");
        if (!title.isEmpty()) state.title = title;
        state.artist = snapshot.optString("artist", "");
        state.position(snapshot.optDouble("position", Double.NaN), snapshot.optDouble("duration", Double.NaN), snapshot.optDouble("rate", 1));
        videoWidth = snapshot.optInt("videoWidth");
        videoHeight = snapshot.optInt("videoHeight");
        reportPlaying();
        if (playing && !active && !allowsBackground()) { send("pause", 0); return; }
        updateService();
    }

    private void reportPlaying() {
        if (presentationChanged != null) presentationChanged.run();
        if (reportedPlaying == state.playing) return;
        reportedPlaying = state.playing;
        if (playingChanged != null) playingChanged.accept(reportedPlaying);
    }

    private void updateService() {
        if (!allowsBackground() || !state.playing && pageUrl == null) {
            BackgroundMediaService.release(context, this);
            return;
        }
        try {
            BackgroundMediaService.update(context, this);
        } catch (RuntimeException error) {
            Log.e("OnceMedia", "Could not start background playback", error);
            send("pause", 0);
            BackgroundMediaService.release(context, this);
            Toast.makeText(context, "Background playback could not start. Reopen Once and try again.", Toast.LENGTH_LONG).show();
        }
    }

    @Override public ReadingMediaState mediaState() { return state; }

    @Override public void command(String action, long position) {
        switch (action) {
            case "play": if (allowsBackground() || active) send("play", 0); break;
            // Dismissing the controls only pauses page media; the page keeps its own player.
            case "pause": case "stop": send("pause", 0); break;
            case "back": seek(state.positionNow() - 10000); break;
            case "forward": seek(state.positionNow() + 10000); break;
            case "seek": seek(position); break;
            default: break;
        }
    }

    private void seek(long position) {
        if (!state.canSeek()) return;
        send("seek", Math.max(0, Math.min(position, state.duration)) / 1000.0);
    }

    private void send(String action, double position) {
        if (page == null) return;
        try { page.accept(new JSONObject().put("type", "media-command").put("action", action).put("position", position)); }
        catch (Exception error) { Log.w("OnceMedia", "Could not command page media", error); }
    }
}
