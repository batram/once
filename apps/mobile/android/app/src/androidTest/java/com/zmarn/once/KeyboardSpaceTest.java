package com.zmarn.once;

import android.app.Instrumentation;
import android.content.Intent;
import android.view.View;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/**
 * However the window came to hold room for a keyboard, it must give it back
 * while no keyboard shows. Each test leaves the decor in the state a missed
 * hide leaves it in, with no interaction behind it, and waits for the room to go.
 */
@RunWith(AndroidJUnit4.class)
public class KeyboardSpaceTest {
    private final Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
    private MainActivity activity;
    private View decor;

    @Before public void start() {
        activity = (MainActivity) instrumentation.startActivitySync(
            new Intent(instrumentation.getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        decor = activity.getWindow().getDecorView();
    }

    @After public void finish() {
        if (activity != null) activity.finish();
    }

    @Test public void staleKeyboardRoomIsReleasedWithoutAnyInteraction() throws Exception {
        assertReleased(leaveKeyboardRoom());
    }

    /** GeckoView takes the decor's insets listener on every attach; no dispatch reaches SystemBars after that. */
    @Test public void staleKeyboardRoomIsReleasedAfterTheInsetsListenerIsTakenOver() throws Exception {
        instrumentation.runOnMainSync(() -> ViewCompat.setOnApplyWindowInsetsListener(decor, (view, insets) ->
            WindowInsetsCompat.toWindowInsetsCompat(view.onApplyWindowInsets(insets.toWindowInsets()))));
        assertReleased(leaveKeyboardRoom());
    }

    /** Pads the decor for an 800px keyboard that is not there; returns the padding it had. */
    private int leaveKeyboardRoom() {
        AtomicInteger settled = new AtomicInteger();
        instrumentation.runOnMainSync(() -> {
            WindowInsetsCompat insets = ViewCompat.getRootWindowInsets(decor);
            assertNotNull(insets);
            assertFalse("The test needs the keyboard down", insets.isVisible(WindowInsetsCompat.Type.ime()));
            settled.set(decor.getPaddingBottom());
            decor.setPadding(decor.getPaddingLeft(), decor.getPaddingTop(), decor.getPaddingRight(), settled.get() + 800);
        });
        return settled.get();
    }

    private void assertReleased(int settled) throws Exception {
        long end = System.nanoTime() + TimeUnit.SECONDS.toNanos(3);
        AtomicInteger bottom = new AtomicInteger();
        do {
            Thread.sleep(50);
            instrumentation.runOnMainSync(() -> bottom.set(decor.getPaddingBottom()));
        } while (bottom.get() != settled && System.nanoTime() < end);
        assertEquals("The keyboard's room must be released while no keyboard shows", settled, bottom.get());
    }
}
