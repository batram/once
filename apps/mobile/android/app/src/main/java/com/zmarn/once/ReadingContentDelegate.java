package com.zmarn.once;

import java.util.function.BooleanSupplier;
import java.util.function.Consumer;
import org.mozilla.geckoview.GeckoSession;
import org.mozilla.geckoview.WebResponse;
import org.mozilla.geckoview.GeckoResult;
import org.mozilla.geckoview.SlowScriptResponse;

/** Routes content-process loss through the surface's page and media cleanup. */
final class ReadingContentDelegate implements GeckoSession.ContentDelegate {
    private final Consumer<String> external;
    private final Consumer<String> stopped;
    private final BooleanSupplier foreground;
    private final Runnable killedWhileHidden;
    private final Runnable painted;
    private final Consumer<String> slowScript;

    ReadingContentDelegate(Consumer<String> external, Consumer<String> stopped,
                           BooleanSupplier foreground, Runnable killedWhileHidden,
                           Runnable painted, Consumer<String> slowScript) {
        this.external = external;
        this.stopped = stopped;
        this.foreground = foreground;
        this.killedWhileHidden = killedWhileHidden;
        this.painted = painted;
        this.slowScript = slowScript;
    }

    @Override public void onExternalResponse(GeckoSession session, WebResponse response) { external.accept(response.uri); }
    @Override public void onCrash(GeckoSession session) { stopped.accept("The page process crashed. Reload to recover."); }
    @Override public void onKill(GeckoSession session) {
        // Android routinely reclaims hidden pages under memory pressure.
        if (foreground.getAsBoolean()) stopped.accept("The page process was stopped. Reload to recover.");
        else killedWhileHidden.run();
    }
    @Override public void onFirstContentfulPaint(GeckoSession session) { painted.run(); }
    @Override public GeckoResult<SlowScriptResponse> onSlowScript(GeckoSession session, String filename) {
        slowScript.accept(filename);
        // This is also Gecko's default. Recovery is provided by the independent
        // native deadline, not by assuming STOP alone cures every script storm.
        return GeckoResult.fromValue(SlowScriptResponse.STOP);
    }
}
