package com.zmarn.once;

import android.app.Activity;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import org.json.JSONObject;
import org.json.JSONArray;
import org.mozilla.geckoview.*;
import java.io.File;
import java.io.FileWriter;

/** Standalone harness: production GeckoEngine and bridge, without the Capacitor shell. */
public class ExtensionBenchmarkActivity extends Activity {
    final JSONObject result = new JSONObject();
    final JSONArray pages = new JSONArray();
    GeckoEngine engine;
    GeckoSession session;
    String mode, fixtureBase;
    long started, navigation;
    boolean opened;
    void put(String key, Object value) { try { result.put(key, value); } catch (Exception e) { throw new RuntimeException(e); } }
    void save() {
        try (FileWriter out = new FileWriter(new File(getFilesDir(), "benchmark.json"))) { out.write(result.toString(2)); }
        catch (Exception e) { throw new RuntimeException(e); }
    }
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        mode = getIntent().getStringExtra("mode");
        fixtureBase = getIntent().getStringExtra("fixtureBase");
        if (fixtureBase == null) fixtureBase = "http://10.0.2.2:18765";
        System.setProperty("once.benchmark.mode", mode);
        new File(getFilesDir(), "profile-" + mode).mkdirs();
        put("mode", mode); put("os", android.os.Build.VERSION.RELEASE); put("pages", pages);
        started = SystemClock.elapsedRealtime();
        engine = GeckoEngine.get(this);
        put("engineCreateMs", SystemClock.elapsedRealtime() - started);
        engine.ready().accept(extensions -> {
            put("prepareMs", SystemClock.elapsedRealtime() - started);
            JSONArray catalog = new JSONArray();
            for (WebExtension extension : extensions) {
                JSONObject item = new JSONObject();
                try { item.put("id", extension.id); item.put("enabled", extension.metaData.enabled); item.put("version", extension.metaData.version); } catch (Exception e) { throw new RuntimeException(e); }
                catalog.put(item);
            }
            put("catalog", catalog);
            session = new GeckoSession();
            session.setProgressDelegate(new GeckoSession.ProgressDelegate() {
                @Override public void onPageStart(GeckoSession s, String url) { navigation = SystemClock.elapsedRealtime(); }
                @Override public void onPageStop(GeckoSession s, boolean success) {
                    JSONObject page = new JSONObject();
                    try { page.put("navigationMs", SystemClock.elapsedRealtime() - navigation); page.put("success", success); } catch (Exception e) { throw new RuntimeException(e); }
                    pages.put(page); save();
                }
            });
            for (WebExtension extension : extensions) {
                if (!extension.id.equals(GeckoEngine.BRIDGE_ID)) continue;
                WebExtension.MessageDelegate router = new WebExtension.MessageDelegate() {
                    @Override public void onConnect(WebExtension.Port port) {
                        port.setDelegate(new WebExtension.PortDelegate() {
                            @Override public void onPortMessage(Object message, WebExtension.Port p) {
                                if (message instanceof JSONObject && "extension-settings-applied".equals(((JSONObject) message).optString("type"))) open();
                            }
                        });
                        if (port.sender.environmentType == WebExtension.MessageSender.ENV_TYPE_EXTENSION) {
                            try {
                                JSONObject lists = new JSONObject().put("lists", new JSONArray());
                                if (mode.startsWith("bridge") && !mode.equals("bridge")) {
                                    lists.getJSONArray("lists").put(new JSONObject().put("enabled", true).put("url", fixtureBase + "/filters/" + mode.substring(6)));
                                }
                                JSONObject scripts = new JSONObject().put("scripts", new JSONArray());
                                port.postMessage(new JSONObject().put("type", "extension-settings").put("revision", 1).put("value", new JSONObject().put("filterLists", lists).put("userscripts", scripts)));
                            } catch (Exception e) { throw new RuntimeException(e); }
                        }
                    }
                };
                extension.setMessageDelegate(router, "once_surface");
                session.getWebExtensionController().setMessageDelegate(extension, router, "once_surface");
            }
            // Match production: an open session starts extension backgrounds.
            GeckoView view = new GeckoView(this); setContentView(view);
            session.open(engine.runtime); view.setSession(session); session.setActive(true);
            engine.runtime.getWebExtensionController().setTabActive(session, true);
            if (mode.equals("bare")) open();
            new Handler(Looper.getMainLooper()).postDelayed(() -> {
                if (!opened) { put("error", "Settings acknowledgement timed out"); save(); }
            }, 15000);
        }, error -> { put("error", error.toString()); save(); });
    }
    void open() {
        if (opened) return;
        opened = true;
        put("readyMs", SystemClock.elapsedRealtime() - started);
        session.loadUri(fixtureBase + "/fixture?run=" + getIntent().getStringExtra("run") + "&page=0");
        save();
    }
}
