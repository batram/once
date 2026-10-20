package com.zmarn.once.lite;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;
import org.junit.Test;

/** Paused requests continue when the shared renderer is blocked, and only then. */
public class FetchWatchdogTest {
    private static final class FakeHost implements FetchWatchdog.Host {
        long now;
        final List<Runnable> scheduled = new ArrayList<>();
        final List<Consumer<Boolean>> pings = new ArrayList<>();
        final List<String> released = new ArrayList<>();
        @Override public long now() { return now; }
        @Override public void schedule(Runnable task, long delayMs) { scheduled.add(task); }
        @Override public void ping(long timeoutMs, Consumer<Boolean> answered) { pings.add(answered); }
        @Override public void release(String targetId, String requestId) { released.add(targetId + "/" + requestId); }

        void runScheduled() {
            List<Runnable> due = new ArrayList<>(scheduled);
            scheduled.clear();
            for (Runnable task : due) task.run();
        }
    }

    @Test public void aBlockedBrokerHasItsStalledRequestsContinued() {
        FakeHost host = new FakeHost();
        FetchWatchdog watchdog = new FetchWatchdog(host);
        watchdog.paused("T1", "R1");
        host.now = 1000;
        watchdog.paused("T1", "R2");
        host.now = 1200;
        host.runScheduled();
        assertEquals("nothing has stalled yet", 0, host.pings.size());
        host.now = FetchWatchdog.STALL_MS + 500;
        host.runScheduled();
        assertEquals(1, host.pings.size());
        host.pings.remove(0).accept(false);
        assertEquals("only the request stalled when the broker was asked", java.util.Arrays.asList("T1/R1"), host.released);
        assertFalse("the broker's late command is refused", watchdog.answered("T1", "R1", true));
        host.now = 2 * FetchWatchdog.STALL_MS + 1000;
        host.runScheduled();
        host.pings.remove(0).accept(false);
        assertEquals(java.util.Arrays.asList("T1/R1", "T1/R2"), host.released);
        assertEquals(0, watchdog.pausedCount());
    }

    @Test public void aBrokerThatAnswersKeepsItsRequestsHeld() {
        FakeHost host = new FakeHost();
        FetchWatchdog watchdog = new FetchWatchdog(host);
        watchdog.paused("T1", "R1");
        host.now = FetchWatchdog.STALL_MS + 1000;
        host.runScheduled();
        host.pings.remove(0).accept(true);
        assertTrue(host.released.isEmpty());
        assertEquals("checked again while it is held", 1, host.scheduled.size());
        assertTrue(watchdog.answered("T1", "R1", false));
        assertEquals("reading the body does not end the pause", 1, watchdog.pausedCount());
        assertTrue(watchdog.answered("T1", "R1", true));
        assertEquals(0, watchdog.pausedCount());
        host.runScheduled();
        assertTrue("nothing left to watch", host.scheduled.isEmpty() && host.pings.isEmpty());
    }

    @Test public void aDetachedTargetTakesItsRequestsAlong() {
        FakeHost host = new FakeHost();
        FetchWatchdog watchdog = new FetchWatchdog(host);
        watchdog.paused("T1", "R1");
        watchdog.paused("T2", "R1");
        watchdog.forgetTarget("T1");
        assertEquals(1, watchdog.pausedCount());
    }
}
