package com.zmarn.once;

import android.content.pm.ApplicationInfo;
import android.util.Log;
import android.webkit.ConsoleMessage;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebChromeClient;

/**
 * Forwards the shell's console to logcat with credentials removed. Capacitor's
 * own logging is off (android.loggingBehavior "none" in capacitor.config.ts):
 * it printed every plugin call and result whole, sync requests with their
 * authorization header among them. Like Capacitor's default, only debuggable
 * builds forward the console.
 */
final class RedactingChromeClient extends BridgeWebChromeClient {
    private static final String TAG = "Capacitor/Console";
    private final boolean enabled;

    RedactingChromeClient(Bridge bridge) {
        super(bridge);
        enabled = (bridge.getContext().getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    }

    @Override
    public boolean onConsoleMessage(ConsoleMessage message) {
        if (!enabled || message.message() == null || !isValidMsg(message.message())) return true;
        String text = LogRedaction.redact(message.sourceId() + ":" + message.lineNumber() + " " + message.message());
        switch (message.messageLevel()) {
            case ERROR: Log.e(TAG, text); break;
            case WARNING: Log.w(TAG, text); break;
            case TIP: case DEBUG: Log.d(TAG, text); break;
            default: Log.i(TAG, text);
        }
        return true;
    }
}
