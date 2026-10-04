package com.zmarn.once;

import android.content.Context;
import android.content.ContextWrapper;
import android.util.AttributeSet;
import android.view.ActionMode;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.CapacitorWebView;
import com.getcapacitor.PluginHandle;

/**
 * The shell WebView. Its text menus start here, so the address field's items
 * are added while the WebView prepares each menu rather than patched in after.
 */
public class ShellWebView extends CapacitorWebView {
    public ShellWebView(Context context, AttributeSet attrs) {
        super(context, attrs);
    }

    @Override public ActionMode startActionMode(ActionMode.Callback callback) {
        return super.startActionMode(decorated(callback));
    }

    @Override public ActionMode startActionMode(ActionMode.Callback callback, int type) {
        return super.startActionMode(decorated(callback), type);
    }

    private ActionMode.Callback decorated(ActionMode.Callback callback) {
        Context context = getContext();
        while (context instanceof ContextWrapper && !(context instanceof BridgeActivity)) {
            context = ((ContextWrapper) context).getBaseContext();
        }
        if (!(context instanceof BridgeActivity) || ((BridgeActivity) context).getBridge() == null) return callback;
        PluginHandle handle = ((BridgeActivity) context).getBridge().getPlugin("AddressBar");
        return handle == null ? callback : ((AddressBarPlugin) handle.getInstance()).decorate(callback);
    }
}
