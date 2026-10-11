package com.zmarn.once;

import android.os.Bundle;
import android.view.MotionEvent;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    ReadingVideo readingVideo;
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AddressBarPlugin.class);
        registerPlugin(SecureSettingsPlugin.class);
        registerPlugin(InAppBrowserSurfacePlugin.class);
        registerPlugin(ViolentmonkeyRelayPlugin.class);
        registerPlugin(ReaderMediaSessionPlugin.class);
        registerPlugin(WebInspectorPlugin.class);
        super.onCreate(savedInstanceState);
        getBridge().getWebView().setWebChromeClient(new RedactingChromeClient(getBridge()));
    }

    @Override public boolean dispatchTouchEvent(MotionEvent event) {
        if (event.getActionMasked() == MotionEvent.ACTION_DOWN) NativeSurfaceDialogs.touched(event.getRawX(), event.getRawY());
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
        if (getBridge() == null || getBridge().getPlugin("InAppBrowserSurface") == null) return;
        ((InAppBrowserSurfacePlugin) getBridge().getPlugin("InAppBrowserSurface").getInstance()).trimMemory(level);
    }
}
