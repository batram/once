package com.zmarn.once;

import android.os.Bundle;
import android.view.MotionEvent;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AddressBarPlugin.class);
        registerPlugin(SecureSettingsPlugin.class);
        registerPlugin(InAppBrowserSurfacePlugin.class);
        registerPlugin(ViolentmonkeyRelayPlugin.class);
        registerPlugin(ReaderMediaSessionPlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override public boolean dispatchTouchEvent(MotionEvent event) {
        if (event.getActionMasked() == MotionEvent.ACTION_DOWN) NativeSurfaceDialogs.touched(event.getRawX(), event.getRawY());
        return super.dispatchTouchEvent(event);
    }

    @Override public void onTrimMemory(int level) {
        super.onTrimMemory(level);
        if (getBridge() == null || getBridge().getPlugin("InAppBrowserSurface") == null) return;
        ((InAppBrowserSurfacePlugin) getBridge().getPlugin("InAppBrowserSurface").getInstance()).trimMemory(level);
    }
}
