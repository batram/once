package com.zmarn.once;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.mozilla.geckoview.MediaSession.Feature;

/** System controls for reader speech, which the TTS engine plays outside Gecko. */
@CapacitorPlugin(name = "ReaderMediaSession")
public class ReaderMediaSessionPlugin extends Plugin {
    // Shown regardless of the page background-playback preference: that only governs Gecko media.
    final BackgroundMediaService.Owner speech = new BackgroundMediaService.Owner() {
        @Override public ReadingMediaState mediaState() { return state; }
        @Override public void command(String action, long position) {
            // Seek and 10-second skips have no meaning for paragraph-based speech.
            if (!"play".equals(action) && !"pause".equals(action) && !"next".equals(action)
                && !"previous".equals(action) && !"stop".equals(action)) return;
            notifyListeners("command", new JSObject().put("action", action));
        }
    };
    private ReadingMediaState state = new ReadingMediaState();

    @PluginMethod
    public void update(PluginCall call) {
        if (!call.getBoolean("playing", false)) { clear(call); return; }
        getActivity().runOnUiThread(() -> {
            int index = call.getInt("index", 0), count = call.getInt("count", 0);
            ReadingMediaState next = new ReadingMediaState();
            next.title = call.getString("title", "");
            if (next.title.isEmpty()) next.title = "Once reader";
            next.artist = call.getString("subtitle", "");
            next.album = count > 0 ? "Paragraph " + (Math.max(0, Math.min(index, count - 1)) + 1) + " of " + count : "";
            next.features = (index > 0 ? Feature.PREVIOUS_TRACK : 0) | (index < count - 1 ? Feature.NEXT_TRACK : 0);
            next.stoppable = true;
            next.playing = !call.getBoolean("paused", false);
            state = next;
            try {
                BackgroundMediaService.update(getContext(), speech);
                call.resolve();
            } catch (RuntimeException error) {
                // Android refuses foreground starts from the background; speech continues without controls.
                BackgroundMediaService.release(getContext(), speech);
                call.reject("Reader media controls could not start", error);
            }
        });
    }

    @PluginMethod
    public void clear(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            state = new ReadingMediaState();
            BackgroundMediaService.release(getContext(), speech);
            call.resolve();
        });
    }

    @Override protected void handleOnDestroy() {
        BackgroundMediaService.release(getContext(), speech);
    }
}
