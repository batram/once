package com.zmarn.once;

import android.util.Log;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONObject;
import org.mozilla.geckoview.WebExtension;

/**
 * Hands the shell's synced filter lists and userscripts to the bridge
 * extension's background page, and holds pages back until it acknowledges them.
 */
final class ExtensionSettingsSync {
    private final ReadingSurfaceHost h;
    private JSONObject extensionSettings;
    /** Counts each settings hand-off; the bridge acknowledges the revision it applied. */
    private long settingsRevision;
    private long appliedSettingsRevision;
    private final List<SettingsWaiter> settingsWaiters = new ArrayList<>();
    private static final long SETTINGS_TIMEOUT_MS = 15000;

    ExtensionSettingsSync(ReadingSurfaceHost host) { h = host; }

    void apply(JSONObject data) {
        extensionSettings = data;
        settingsRevision++;
        sendExtensionSettings();
    }

    /** The background page connected: it receives the current settings at once. */
    void connected(WebExtension.Port port) {
        h.settingsPort = port;
        port.setDelegate(new SettingsPort());
        sendExtensionSettings();
    }

    void whenApplied(Runnable work) {
        if (extensionSettings == null || appliedSettingsRevision >= settingsRevision) { work.run(); return; }
        SettingsWaiter waiter = new SettingsWaiter(work);
        settingsWaiters.add(waiter);
        h.handler.postDelayed(waiter, SETTINGS_TIMEOUT_MS);
    }

    /** Bounded: an unreachable filter list host must not keep every page from opening. */
    private final class SettingsWaiter implements Runnable {
        private final Runnable work;

        SettingsWaiter(Runnable work) { this.work = work; }

        @Override
        public void run() {
            if (!settingsWaiters.remove(this)) return;
            Log.w(ReadingSurfaceHost.TAG, "Extension settings were not applied in time; opening the page without them");
            work.run();
        }

        void applied() {
            if (!settingsWaiters.remove(this)) return;
            h.handler.removeCallbacks(this);
            work.run();
        }
    }

    private void sendExtensionSettings() {
        WebExtension.Port settingsPort = h.settingsPort;
        if (settingsPort == null || extensionSettings == null) return;
        try {
            JSONObject message = new JSONObject();
            message.put("type", "extension-settings");
            message.put("revision", settingsRevision);
            message.put("value", extensionSettings);
            settingsPort.postMessage(message);
        } catch (Exception error) {
            Log.e(ReadingSurfaceHost.TAG, "Unable to send extension settings", error);
        }
    }

    private final class SettingsPort implements WebExtension.PortDelegate {
        @Override
        public void onPortMessage(Object message, WebExtension.Port port) {
            if (!(message instanceof JSONObject)) return;
            JSONObject reply = (JSONObject) message;
            if (!"extension-settings-applied".equals(reply.optString("type"))) return;
            appliedSettingsRevision = Math.max(appliedSettingsRevision, reply.optLong("revision"));
            if (appliedSettingsRevision < settingsRevision) return;
            for (SettingsWaiter waiter : new ArrayList<>(settingsWaiters)) waiter.applied();
        }

        @Override
        public void onDisconnect(WebExtension.Port port) {
            if (h.settingsPort == port) h.settingsPort = null;
        }
    }
}
