package com.zmarn.once;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;
import android.widget.Toast;
import org.json.JSONObject;
import org.mozilla.geckoview.GeckoSession;
import org.mozilla.geckoview.Image;
import org.mozilla.geckoview.MediaSession;
import org.mozilla.geckoview.WebExtension;

/** The reading session's persisted playback policy, independent of view visibility. */
final class BackgroundMedia implements MediaSession.Delegate {
    private final Context context;
    private final SharedPreferences preferences;
    private GeckoSession session;
    private MediaSession playing;
    private boolean active = true;
    private WebExtension.Port port;
    private Image artwork;
    private String pageUrl;
    private boolean nativePosition;
    private String nativeTitle = "", nativeArtist = "";
    ReadingMediaState state = new ReadingMediaState();

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
        observePage();
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
            BackgroundMediaService.update(context, this);
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
        state.playing(true);
        observePage();
        if (!active && !isEnabled()) { media.pause(); return; }
        updateService();
    }

    @Override public void onPause(GeckoSession source, MediaSession media) {
        if (source != session || playing != media) return;
        state.playing(false);
        updateService();
    }
    @Override public void onStop(GeckoSession source, MediaSession media) { stopped(source, media); }
    @Override public void onDeactivated(GeckoSession source, MediaSession media) { stopped(source, media); }

    private void stopped(GeckoSession source, MediaSession media) {
        if (source != session || playing != media) return;
        reset();
    }

    void reset() {
        playing = null;
        artwork = null;
        pageUrl = null;
        nativePosition = false;
        nativeTitle = "";
        nativeArtist = "";
        state = new ReadingMediaState();
        BackgroundMediaService.stop(context);
    }

    void detach() {
        if (session != null) session.setMediaSessionDelegate(null);
        session = null;
        port = null;
        reset();
    }

    void attachPort(WebExtension.Port port) {
        this.port = port;
        pageUrl = null;
        state.pageSeekable = false;
        observePage();
    }

    private void observePage() {
        if (port == null) return;
        try { port.postMessage(new JSONObject().put("type", "media-observe").put("enabled", isEnabled())); }
        catch (Exception error) { Log.w("OnceMedia", "Media page bridge disconnected", error); }
    }

    void pageSnapshot(JSONObject snapshot) {
        if (!isEnabled() || port == null) return;
        String url = snapshot.optString("url", "");
        String scheme = android.net.Uri.parse(url).getScheme();
        if (!"https".equals(scheme) && !"http".equals(scheme)) return;
        pageUrl = url;
        state.pageSeekable = snapshot.optBoolean("seekable");
        String title = snapshot.optString("title", "");
        String artist = snapshot.optString("artist", "");
        if (nativeTitle.isEmpty() && !title.isEmpty()) state.title = title;
        if (nativeArtist.isEmpty()) state.artist = artist;
        if (!nativePosition) state.position(snapshot.optDouble("position", Double.NaN), snapshot.optDouble("duration", Double.NaN), snapshot.optDouble("rate", 1));
        updateService();
    }

    void command(String action, long position) {
        if (playing == null) return;
        switch (action) {
            case "play": if (isEnabled() || active) playing.play(); break;
            case "pause": playing.pause(); break;
            case "next": if (state.supports(MediaSession.Feature.NEXT_TRACK)) playing.nextTrack(); break;
            case "previous": if (state.supports(MediaSession.Feature.PREVIOUS_TRACK)) playing.previousTrack(); break;
            case "back": seek(state.positionNow() - 10000); break;
            case "forward": seek(state.positionNow() + 10000); break;
            case "seek": seek(position); break;
        }
    }

    private void seek(long position) {
        if (!state.canSeek()) return;
        double seconds = Math.max(0, Math.min(position, state.duration)) / 1000.0;
        if (pageUrl != null && port != null && state.pageSeekable && !state.supports(MediaSession.Feature.SEEK_TO)) {
            try { port.postMessage(new JSONObject().put("type", "media-command").put("action", "seek")
                .put("url", pageUrl).put("position", seconds)); }
            catch (Exception error) { Log.w("OnceMedia", "Could not seek page media", error); }
        } else playing.seekTo(seconds, false);
    }

    @Override public void onMetadata(GeckoSession source, MediaSession media, MediaSession.Metadata metadata) {
        if (source != session) return;
        nativeTitle = metadata.title == null ? "" : metadata.title;
        nativeArtist = metadata.artist == null ? "" : metadata.artist;
        if (!nativeTitle.isEmpty()) state.title = nativeTitle;
        if (!nativeArtist.isEmpty()) state.artist = nativeArtist;
        state.album = metadata.album == null ? "" : metadata.album;
        if (artwork != metadata.artwork) {
            artwork = metadata.artwork;
            state.artwork = null;
            if (artwork != null) {
                Image request = artwork;
                request.getBitmap(384).accept(bitmap -> {
                    if (artwork == request && session == source) { state.artwork = bitmap; updateService(); }
                }, error -> Log.d("OnceMedia", "Artwork unavailable", error));
            }
        }
        updateService();
    }

    @Override public void onPositionState(GeckoSession source, MediaSession media, MediaSession.PositionState position) {
        if (source != session) return;
        nativePosition = Double.isFinite(position.duration) && position.duration > 0 && Double.isFinite(position.position);
        state.position(position.position, position.duration, position.playbackRate);
        updateService();
    }

    @Override public void onFeatures(GeckoSession source, MediaSession media, long features) {
        if (source != session) return;
        state.features = features;
        updateService();
    }
}
