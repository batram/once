package com.zmarn.once;

import java.util.function.BooleanSupplier;
import java.util.function.Consumer;
import org.mozilla.geckoview.GeckoSession;
import org.mozilla.geckoview.WebResponse;

/** Routes content-process loss through the surface's page and media cleanup. */
final class ReadingContentDelegate implements GeckoSession.ContentDelegate {
    private final Consumer<String> external;
    private final Consumer<String> stopped;
    private final BooleanSupplier foreground;
    private final Runnable killedWhileHidden;

    ReadingContentDelegate(Consumer<String> external, Consumer<String> stopped,
                           BooleanSupplier foreground, Runnable killedWhileHidden) {
        this.external = external;
        this.stopped = stopped;
        this.foreground = foreground;
        this.killedWhileHidden = killedWhileHidden;
    }

    @Override public void onExternalResponse(GeckoSession session, WebResponse response) { external.accept(response.uri); }
    @Override public void onCrash(GeckoSession session) { stopped.accept("The page process crashed. Reload to recover."); }
    @Override public void onKill(GeckoSession session) {
        // Android routinely reclaims hidden pages under memory pressure.
        if (foreground.getAsBoolean()) stopped.accept("The page process was stopped. Reload to recover.");
        else killedWhileHidden.run();
    }
}
