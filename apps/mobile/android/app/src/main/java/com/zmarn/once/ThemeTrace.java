package com.zmarn.once;

import android.app.Activity;
import android.app.UiModeManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.content.res.Resources;
import android.util.Log;

/**
 * Records which layer believed the system was dark, on each resume and each
 * configuration change, so a theme that stays stale after a night in the
 * background can be traced to its layer: the activity, or the process the
 * system's change may never have reached. Kept in preferences, which
 * survive the hours that roll logcat's buffers; read with
 * `run-as <package> cat shared_prefs/once_theme_trace.xml`.
 */
final class ThemeTrace {
    private static final String TAG = "OnceTheme";
    private static final String PREFS = "once_theme_trace";
    private static final int MAX_LINES = 40;

    private ThemeTrace() {}

    static void record(Activity activity, String event) {
        append(activity, event
            + " activity=" + night(activity.getResources().getConfiguration())
            + " app=" + night(activity.getApplicationContext().getResources().getConfiguration())
            + " system=" + night(Resources.getSystem().getConfiguration())
            + " setting=" + nightSetting(activity));
    }

    /** What the shell page itself matches, a moment after resume, once its own update had time to land. */
    static void recordShell(Activity activity, android.webkit.WebView shell) {
        if (shell == null) return;
        shell.postDelayed(() -> shell.evaluateJavascript(
            "matchMedia('(prefers-color-scheme: dark)').matches",
            dark -> append(activity, "shell dark=" + dark)), 1000);
    }

    private static void append(Activity activity, String entry) {
        String line = System.currentTimeMillis() + " " + entry;
        Log.i(TAG, line);
        SharedPreferences prefs = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String previous = prefs.getString("lines", "");
        String[] lines = previous.isEmpty() ? new String[0] : previous.split("\n");
        StringBuilder kept = new StringBuilder();
        for (int index = Math.max(0, lines.length - (MAX_LINES - 1)); index < lines.length; index++) {
            kept.append(lines[index]).append('\n');
        }
        prefs.edit().putString("lines", kept.append(line).toString()).apply();
    }

    private static String night(Configuration configuration) {
        int mode = configuration.uiMode & Configuration.UI_MODE_NIGHT_MASK;
        return mode == Configuration.UI_MODE_NIGHT_YES ? "dark" : mode == Configuration.UI_MODE_NIGHT_NO ? "light" : "unset";
    }

    private static String nightSetting(Activity activity) {
        UiModeManager modes = (UiModeManager) activity.getSystemService(Context.UI_MODE_SERVICE);
        if (modes == null) return "?";
        switch (modes.getNightMode()) {
            case UiModeManager.MODE_NIGHT_AUTO: return "auto";
            case UiModeManager.MODE_NIGHT_YES: return "yes";
            case UiModeManager.MODE_NIGHT_NO: return "no";
            case UiModeManager.MODE_NIGHT_CUSTOM: return "custom";
            default: return String.valueOf(modes.getNightMode());
        }
    }
}
