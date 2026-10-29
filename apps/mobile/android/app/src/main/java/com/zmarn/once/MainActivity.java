package com.zmarn.once;

import android.os.Bundle;
import android.view.MotionEvent;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.PluginHandle;

public class MainActivity extends BridgeActivity {
    VideoPresentation readingVideo;
    private KeyboardSpace keyboardSpace;
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AddressBarPlugin.class);
        registerPlugin(SecureSettingsPlugin.class);
        registerPlugin(NativeDatabasePlugin.class);
        registerPlugin(BrowserHistoryPlugin.class);
        // The engine flavour (GeckoView or Once Lite) registers InAppBrowserSurface
        // and GeckoViolentmonkey, the plugins whose implementation differs.
        EngineSurface.register(this);
        registerPlugin(ReaderMediaSessionPlugin.class);
        registerPlugin(WebInspectorPlugin.class);
        registerPlugin(TouchSelectionPlugin.class);
        super.onCreate(savedInstanceState);
        getBridge().getWebView().setWebChromeClient(new RedactingChromeClient(getBridge()));
        getBridge().addWebViewListener(new ShellRenderRecovery(this));
        keyboardSpace = KeyboardSpace.install(getWindow().getDecorView());
    }

    @Override public void onResume() {
        super.onResume();
        if (keyboardSpace != null) keyboardSpace.schedule();
        ThemeTrace.record(this, "resume");
        if (getBridge() != null) ThemeTrace.recordShell(this, getBridge().getWebView());
    }

    @Override public void onConfigurationChanged(android.content.res.Configuration configuration) {
        super.onConfigurationChanged(configuration);
        ThemeTrace.record(this, "config");
    }

    @Override public boolean dispatchTouchEvent(MotionEvent event) {
        if (event.getActionMasked() == MotionEvent.ACTION_DOWN) {
            NativeSurfaceDialogs.touched(event.getRawX(), event.getRawY());
            if (getBridge() != null && getBridge().getPlugin("TouchSelection") != null)
                ((TouchSelectionPlugin) getBridge().getPlugin("TouchSelection").getInstance()).realTouchStarted();
        }
        return super.dispatchTouchEvent(event);
    }

    @Override protected void onUserLeaveHint() {
        if (readingVideo != null) readingVideo.leave();
        super.onUserLeaveHint();
    }

    @Override public void onPictureInPictureModeChanged(boolean enabled, android.content.res.Configuration configuration) {
        super.onPictureInPictureModeChanged(enabled, configuration);
        if (readingVideo != null) readingVideo.pipChanged(enabled);
    }

    @Override public void onTrimMemory(int level) {
        super.onTrimMemory(level);
        ReadingSurfaceEngine surface = surface();
        if (surface != null) surface.trimMemory(level);
    }

    /** The engine's reading surface plugin, once the bridge has it. */
    ReadingSurfaceEngine surface() {
        if (getBridge() == null) return null;
        PluginHandle handle = getBridge().getPlugin("InAppBrowserSurface");
        return handle == null ? null : (ReadingSurfaceEngine) handle.getInstance();
    }
}
