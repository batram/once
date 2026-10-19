package com.zmarn.once;

import android.app.Instrumentation;
import android.content.Intent;
import androidx.test.platform.app.InstrumentationRegistry;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;
import org.mozilla.geckoview.GeckoResult;
import static org.junit.Assert.*;

final class GeckoTestSupport {
    final Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
    MainActivity activity;
    InAppBrowserSurfacePlugin plugin;
    void start() throws Exception {
        assertTrue(instrumentation.getTargetContext().getPackageName().endsWith(".dev"));
        shell("input keyevent KEYCODE_WAKEUP");
        shell("wm dismiss-keyguard");
        activity = (MainActivity) instrumentation.startActivitySync(new Intent(instrumentation.getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        ui(() -> activity.getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON));
        until("The foreground test activity must have a focused, laid-out window",
            () -> activity.hasWindowFocus() && activity.getWindow().getDecorView().getWidth() > 0, 15);
        plugin = (InAppBrowserSurfacePlugin) activity.getBridge().getPlugin("InAppBrowserSurface").getInstance();
    }
    private void shell(String command) {
        try (InputStream output = new android.os.ParcelFileDescriptor.AutoCloseInputStream(
                instrumentation.getUiAutomation().executeShellCommand(command))) {
            byte[] buffer = new byte[256];
            while (output.read(buffer) != -1) { /* Wait for the command to complete. */ }
        } catch (IOException error) { throw new AssertionError(error); }
    }
    void ui(Runnable work) { instrumentation.runOnMainSync(work); }
    GeckoEngine engine() {
        AtomicReference<GeckoEngine> value = new AtomicReference<>();
        ui(() -> value.set(GeckoEngine.get(activity)));
        return value.get();
    }
    <T> T result(Supplier<GeckoResult<T>> work) throws Exception {
        CountDownLatch latch = new CountDownLatch(1);
        AtomicReference<T> value = new AtomicReference<>();
        AtomicReference<Throwable> failure = new AtomicReference<>();
        ui(() -> work.get().accept(v -> { value.set(v); latch.countDown(); }, e -> { failure.set(e); latch.countDown(); }));
        assertTrue("Gecko result deadline", latch.await(40, TimeUnit.SECONDS));
        if (failure.get() != null) throw new AssertionError(failure.get());
        return value.get();
    }
    Object field(String name) { return field(plugin, name); }
    static Object field(Object owner, String name) {
        for (Class<?> type = owner.getClass(); type != null; type = type.getSuperclass()) {
            try { java.lang.reflect.Field f = type.getDeclaredField(name); f.setAccessible(true); return f.get(owner); }
            catch (NoSuchFieldException ignored) { /* State can be owned by the native host superclass. */ }
            catch (IllegalAccessException e) { throw new AssertionError(e); }
        }
        throw new AssertionError("Missing field: " + name);
    }
    void until(String message, BooleanSupplier condition, int seconds) throws Exception {
        long end = System.nanoTime() + TimeUnit.SECONDS.toNanos(seconds);
        AtomicReference<Boolean> done = new AtomicReference<>(false);
        do { ui(() -> done.set(condition.getAsBoolean())); if (done.get()) return; Thread.sleep(100); } while (System.nanoTime() < end);
        fail(message);
    }
    void open(String url) throws Exception {
        Call call = new Call(new JSObject().put("url", url).put("visible", true)
            .put("bounds", new JSObject().put("x", 0).put("y", 100).put("width", 320).put("height", 500)));
        ui(() -> plugin.open(call)); call.await();
    }
    void navigate(String url) throws Exception {
        Call call = new Call(new JSObject().put("url", url)); ui(() -> plugin.navigate(call)); call.await();
    }
    String evaluate(String code) throws Exception {
        Call call = new Call(new JSObject().put("script", code)); ui(() -> plugin.evaluateJavaScript(call)); call.await();
        return call.value.getString("value");
    }
    void close() throws Exception { Call call = new Call(new JSObject()); ui(() -> plugin.close(call)); call.await(); }
    void ready(String marker) throws Exception {
        until("Bridge did not connect", () -> field("bridgePort") != null, 35);
        long end = System.nanoTime() + TimeUnit.SECONDS.toNanos(35);
        do {
            try { if (("\"" + marker + "\"").equals(evaluate("document.querySelector('#ready')?.textContent"))) return; }
            catch (AssertionError ignored) { }
            Thread.sleep(100);
        } while (System.nanoTime() < end);
        fail("Document did not become usable: " + marker);
    }
    static final class Call extends PluginCall {
        final CountDownLatch done = new CountDownLatch(1);
        volatile JSObject value;
        volatile String error;
        Call(JSObject data) { super(null, "InAppBrowserSurface", "test", "test", data); }
        @Override public void resolve() { done.countDown(); }
        @Override public void resolve(JSObject value) { this.value = value; done.countDown(); }
        @Override public void reject(String message) { error = message; done.countDown(); }
        @Override public void reject(String message, Exception cause) { reject(message + ": " + cause); }
        void await() throws Exception { assertTrue("Native call deadline", done.await(40, TimeUnit.SECONDS)); assertNull(error, error); }
    }
    static final class Fixture implements AutoCloseable {
        final ServerSocket server = new ServerSocket(0);
        final ExecutorService workers = Executors.newCachedThreadPool();
        volatile boolean stall = true;
        Fixture() throws IOException {
            workers.submit(() -> { while (!server.isClosed()) {
                try { Socket socket = server.accept(); workers.submit(() -> serve(socket)); }
                catch (IOException e) { if (!server.isClosed()) throw new UncheckedIOException(e); }
            }});
        }
        String url(String path) { return "http://127.0.0.1:" + server.getLocalPort() + path; }
        void serve(Socket socket) {
            try (Socket connection = socket) {
                BufferedReader reader = new BufferedReader(new InputStreamReader(connection.getInputStream()));
                String request = reader.readLine();
                String line; while ((line = reader.readLine()) != null && !line.isEmpty()) {}
                String path = request.split(" ")[1];
                if (path.equals("/redirect")) {
                    connection.getOutputStream().write("HTTP/1.1 302 Found\r\nLocation: /redirected\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
                    // /redirected is the destination, not another redirect.
                    return;
                }
                if (path.startsWith("/stall") && stall) { Thread.sleep(90000); return; }
                String script = path.startsWith("/spin") ? "<script>setTimeout(()=>{while(true){}},300)</script>" : "";
                if (path.startsWith("/interactive")) script = "<img src='/stall-image'>";
                if (path.startsWith("/memory")) script = "<script>window.chunks=[];for(let i=0;i<48;i++){let b=new Uint8Array(4*1024*1024);b.fill(42);chunks.push(b)}</script>";
                byte[] body = ("<!doctype html><html><head><title>Once baseline</title></head><body style='background:#123456;color:white'><p id='ready'>" + path.substring(1) + "</p>" + script + "</body></html>").getBytes(StandardCharsets.UTF_8);
                if (path.equals("/blank-late")) body = ("<!doctype html><html><body><script>setTimeout(()=>{document.body.innerHTML='<p id=ready>late-content</p>'},22000)</script></body></html>").getBytes(StandardCharsets.UTF_8);
                connection.getOutputStream().write(("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: " + body.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
                connection.getOutputStream().write(body);
            } catch (Exception ignored) { }
        }
        @Override public void close() throws Exception { server.close(); workers.shutdownNow(); }
    }
}
