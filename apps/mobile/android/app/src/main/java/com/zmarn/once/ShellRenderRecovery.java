package com.zmarn.once;

import android.net.Uri;
import android.os.SystemClock;
import android.util.Log;
import android.view.ViewGroup;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.MessageHandler;
import com.getcapacitor.PluginHandle;
import com.getcapacitor.WebViewListener;
import java.lang.reflect.AccessibleObject;
import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.Collections;

/**
 * Keeps the app alive when the shell WebView's renderer goes away. The renderer
 * is a separate sandboxed process that lmkd reaps on its own, and Android kills
 * this whole process too unless onRenderProcessGone claims the loss.
 *
 * The dead view is replaced inside the existing Bridge, so the plugins, and with
 * them the engine's reading sessions and background media, outlive the shell page;
 * the restarted page restores its saved tabs onto the same native tab runtimes.
 * Capacitor keeps its WebView in private fields, so if those have moved the
 * activity is recreated instead, which still beats losing the process.
 */
final class ShellRenderRecovery extends WebViewListener {
    private static final String TAG = "OnceShell";
    /** A renderer that dies again straight after each restart is not worth chasing. */
    private static final int BURST_LIMIT = 3;
    private static final long BURST_WINDOW_MS = 60_000;

    private final BridgeActivity activity;
    private final long[] recent = new long[BURST_LIMIT];
    private int recentCount;

    ShellRenderRecovery(BridgeActivity activity) {
        this.activity = activity;
    }

    @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
        Bridge bridge = activity.getBridge();
        Log.w(TAG, (detail.didCrash() ? "Shell renderer crashed" : "Shell renderer was killed, likely for memory")
            + "; priority at exit " + detail.rendererPriorityAtExit());
        if (bridge == null || view != bridge.getWebView()) {
            // A view already replaced; nothing depends on it any more.
            discard(view);
            return true;
        }
        if (!admit(SystemClock.elapsedRealtime())) {
            Log.e(TAG, "Shell renderer died " + BURST_LIMIT + " times within " + BURST_WINDOW_MS + " ms; letting Android end the app");
            return false;
        }
        if (activity.isFinishing() || activity.isDestroyed()) {
            discard(view);
            return true;
        }
        if (replace(bridge, view)) {
            Log.i(TAG, "Shell WebView replaced; reading sessions kept");
            return true;
        }
        discard(view);
        Log.w(TAG, "Recreating the activity to restore the shell");
        activity.recreate();
        return true;
    }

    private boolean admit(long now) {
        int kept = 0;
        for (int index = 0; index < recentCount; index++) {
            if (now - recent[index] < BURST_WINDOW_MS) recent[kept++] = recent[index];
        }
        recentCount = kept;
        if (recentCount >= BURST_LIMIT) return false;
        recent[recentCount++] = now;
        return true;
    }

    /** Swaps a new shell view into the Bridge and loads the app into it. */
    private boolean replace(Bridge bridge, WebView dead) {
        ViewGroup parent = (ViewGroup) dead.getParent();
        if (parent == null) return false;
        Field webView, messages, pluginManager, cordovaWebView;
        Method initWebView, injector;
        // Cordova's plugin manager is not on the app's compile classpath.
        Constructor<MessageHandler> messageHandler;
        try {
            webView = accessible(Bridge.class.getDeclaredField("webView"));
            messages = accessible(Bridge.class.getDeclaredField("msgHandler"));
            cordovaWebView = accessible(Bridge.class.getDeclaredField("cordovaWebView"));
            pluginManager = accessible(MessageHandler.class.getDeclaredField("cordovaPluginManager"));
            messageHandler = MessageHandler.class.getConstructor(Bridge.class, WebView.class, pluginManager.getType());
            initWebView = accessible(Bridge.class.getDeclaredMethod("initWebView"));
            injector = accessible(Bridge.class.getDeclaredMethod("getJSInjector"));
        } catch (ReflectiveOperationException | RuntimeException error) {
            Log.w(TAG, "Capacitor's Bridge no longer exposes its WebView fields", error);
            return false;
        }
        int index = parent.indexOfChild(dead);
        ViewGroup.LayoutParams params = dead.getLayoutParams();
        // Bridge.loadWebView cannot run again: its chrome client registers activity
        // result launchers, which Android refuses once the activity has started.
        // The clients hold the Bridge, not the view, so the new view reuses them,
        // and the local server that serves the app outlives the view as well.
        WebViewClient client = dead.getWebViewClient();
        WebChromeClient chrome = dead.getWebChromeClient();
        ShellWebView fresh = new ShellWebView(activity, null);
        fresh.setId(dead.getId());
        try {
            Object plugins = pluginManager.get(messages.get(bridge));
            discard(dead);
            // Same index: the reading surfaces and extension pages sit above the shell.
            parent.addView(fresh, index, params);
            webView.set(bridge, fresh);
            fresh.setBridge(bridge);
            initWebView.invoke(bridge);
            messages.set(bridge, messageHandler.newInstance(bridge, fresh, plugins));
            retarget(cordovaWebView.get(bridge), fresh);
            if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                Object script = injector.invoke(bridge);
                String code = (String) accessible(script.getClass().getMethod("getScriptString")).invoke(script);
                String origin = Uri.parse(bridge.getAppUrl()).buildUpon().path(null).fragment(null).clearQuery().build().toString();
                WebViewCompat.addDocumentStartJavaScript(fresh, code, Collections.singleton(origin));
            }
            fresh.setWebViewClient(client);
            fresh.setWebChromeClient(chrome);
            // Capacitor's WebView setup resets inspection to its config default.
            if (WebInspectorPlugin.allowed(activity)) WebView.setWebContentsDebuggingEnabled(true);
            databaseShellRestarted(bridge);
            fresh.loadUrl(bridge.getAppUrl());
            surfacesShellRestarted(bridge);
            return true;
        } catch (ReflectiveOperationException | RuntimeException error) {
            Log.w(TAG, "Replacing the shell WebView failed", error);
            if (fresh.getParent() != null) parent.removeView(fresh);
            fresh.destroy();
            return false;
        }
    }

    /** Cordova's mock view pauses and resumes the WebView it was given; point it at the new one. */
    private static void retarget(Object cordova, WebView fresh) {
        if (cordova == null) return;
        try {
            accessible(cordova.getClass().getDeclaredField("webView")).set(cordova, fresh);
        } catch (ReflectiveOperationException | RuntimeException error) {
            Log.w(TAG, "Cordova keeps the old shell WebView", error);
        }
    }

    private static <T extends AccessibleObject> T accessible(T member) {
        member.setAccessible(true);
        return member;
    }

    /** A view whose renderer is gone is unusable; it must leave the hierarchy and be destroyed. */
    private static void discard(WebView view) {
        ViewGroup parent = (ViewGroup) view.getParent();
        if (parent != null) parent.removeView(view);
        view.destroy();
    }

    private static void databaseShellRestarted(Bridge bridge) {
        PluginHandle handle = bridge.getPlugin("NativeDatabase");
        if (handle != null) ((NativeDatabasePlugin) handle.getInstance()).shellRestarted();
    }

    private static void surfacesShellRestarted(Bridge bridge) {
        PluginHandle handle = bridge.getPlugin("InAppBrowserSurface");
        if (handle != null) ((ReadingSurfaceEngine) handle.getInstance()).shellRestarted();
    }
}
