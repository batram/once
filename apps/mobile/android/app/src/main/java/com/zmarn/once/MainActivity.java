package com.zmarn.once;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(SecureSettingsPlugin.class);
        registerPlugin(InAppBrowserSurfacePlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override public void onTrimMemory(int level) {
        super.onTrimMemory(level);
        if (getBridge() == null || getBridge().getPlugin("InAppBrowserSurface") == null) return;
        ((InAppBrowserSurfacePlugin) getBridge().getPlugin("InAppBrowserSurface").getInstance()).trimMemory(level);
    }
}
