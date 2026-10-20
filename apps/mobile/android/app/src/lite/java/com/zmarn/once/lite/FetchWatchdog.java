package com.zmarn.once.lite;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;

/**
 * Keeps a blocked renderer from holding every paused request forever.
 * Every WebView of the app shares one renderer main thread, the broker's
 * included: while a page sits in a synchronous XMLHttpRequest (or a JS
 * dialog), the broker cannot answer the `Fetch.requestPaused` that request
 * is waiting for, and DevTools never times a paused request out. So a
 * request the broker has not decided within {@link #STALL_MS} makes Java ask
 * the broker for a sign of life (`broker.ping`); when that goes unanswered
 * for {@link #PING_TIMEOUT_MS}, every request stalled that long is continued
 * as it is. A broker that answers is holding requests on purpose (the
 * Violentmonkey hand-off, uBlock's start-up), and they stay held. Commands
 * the broker sends later for a released request are refused (`RELEASED`).
 */
final class FetchWatchdog {
    static final long STALL_MS = 1500;
    static final long PING_TIMEOUT_MS = 3000;
    static final long CHECK_MS = 1000;
    private static final int RELEASED_LIMIT = 1024;

    interface Host {
        long now();
        /** Runs the task later, on the thread that owns the watchdog's checks. */
        void schedule(Runnable task, long delayMs);
        /** Asks the broker to answer; `answered` gets true when it did within the timeout. */
        void ping(long timeoutMs, Consumer<Boolean> answered);
        /** Continues the paused request unchanged. */
        void release(String targetId, String requestId);
    }

    private final Host host;
    /** `targetId|requestId` → when it paused, oldest first. */
    private final Map<String, Long> paused = new LinkedHashMap<>();
    private final Map<String, Boolean> released = new LinkedHashMap<String, Boolean>(16, 0.75f, false) {
        @Override protected boolean removeEldestEntry(Map.Entry<String, Boolean> eldest) { return size() > RELEASED_LIMIT; }
    };
    private boolean scheduled;
    private boolean pinging;

    FetchWatchdog(Host host) { this.host = host; }

    private static String key(String targetId, String requestId) { return targetId + "|" + requestId; }

    /** A request paused and went to the broker. Any thread. */
    void paused(String targetId, String requestId) {
        synchronized (this) {
            paused.put(key(targetId, requestId), host.now());
            if (scheduled) return;
            scheduled = true;
        }
        host.schedule(this::check, CHECK_MS);
    }

    /**
     * The broker sent a command for the request; `resolves` when it ends the
     * pause (continue, fail, fulfill). False when Java released the request
     * already: the command must not reach DevTools.
     */
    synchronized boolean answered(String targetId, String requestId, boolean resolves) {
        String key = key(targetId, requestId);
        if (released.containsKey(key)) return false;
        if (resolves) paused.remove(key);
        return true;
    }

    /** The target went away with its requests. */
    synchronized void forgetTarget(String targetId) {
        String prefix = targetId + "|";
        paused.keySet().removeIf(key -> key.startsWith(prefix));
    }

    synchronized int pausedCount() { return paused.size(); }

    void check() {
        long now = host.now();
        synchronized (this) {
            scheduled = false;
            if (paused.isEmpty()) return;
            boolean stalled = false;
            for (long since : paused.values()) if (now - since >= STALL_MS) { stalled = true; break; }
            if (!stalled || pinging) { reschedule(); return; }
            pinging = true;
        }
        host.ping(PING_TIMEOUT_MS, answered -> {
            List<String> release = new ArrayList<>();
            synchronized (this) {
                pinging = false;
                if (!answered) {
                    for (Iterator<Map.Entry<String, Long>> entries = paused.entrySet().iterator(); entries.hasNext(); ) {
                        Map.Entry<String, Long> entry = entries.next();
                        if (now - entry.getValue() < STALL_MS) continue;
                        entries.remove();
                        released.put(entry.getKey(), true);
                        release.add(entry.getKey());
                    }
                }
                if (!paused.isEmpty()) reschedule();
            }
            for (String key : release) {
                int separator = key.indexOf('|');
                host.release(key.substring(0, separator), key.substring(separator + 1));
            }
        });
    }

    /** With the lock held. */
    private void reschedule() {
        if (scheduled) return;
        scheduled = true;
        host.schedule(this::check, CHECK_MS);
    }
}
