package com.zmarn.once;

import android.app.Instrumentation;
import android.content.Intent;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/** The shell page outlives its activity by a few calls; the database must refuse them, not end the process. */
@RunWith(AndroidJUnit4.class)
public class NativeDatabaseClosedTest {
    @Test public void aCallAfterTheActivityWasDestroyedIsRejected() throws Exception {
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        MainActivity activity = (MainActivity) instrumentation.startActivitySync(
            new Intent(instrumentation.getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        NativeDatabasePlugin plugin = (NativeDatabasePlugin) activity.getBridge().getPlugin("NativeDatabase").getInstance();
        instrumentation.runOnMainSync(activity::finish);
        long deadline = System.nanoTime() + 15_000_000_000L;
        while (!activity.isDestroyed()) {
            assertTrue("The activity must be destroyed", System.nanoTime() < deadline);
            Thread.sleep(50);
        }
        AtomicReference<String> rejected = new AtomicReference<>();
        plugin.execute(new PluginCall(null, "NativeDatabase", "test", "execute", new JSObject().put("operation", "info")) {
            @Override public void reject(String message) { rejected.set(message); }
            @Override public void reject(String message, Exception cause) { rejected.set(message); }
            @Override public void resolve(JSObject result) { rejected.set("resolved"); }
        });
        assertEquals("Native database is closed", rejected.get());
    }
}
