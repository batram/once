package com.zmarn.once;

import com.getcapacitor.Bridge;
import android.app.AlertDialog;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.widget.EditText;
import android.widget.PopupMenu;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONObject;


final class NativeSurfaceDialogs {
    static void showMenu(Bridge bridge, PluginCall call) {
        bridge.getActivity().runOnUiThread(() -> {
            JSArray items = call.getArray("items");
            if (items == null) {
                call.reject("Native menu items are required");
                return;
            }
            String[] labels = new String[items.length()];
            String[] ids = new String[items.length()];
            boolean[] enabled = new boolean[items.length()];
            try {
                for (int index = 0; index < items.length(); index++) {
                    JSONObject item = items.getJSONObject(index);
                    labels[index] = item.optString("label");
                    ids[index] = item.optString("id");
                    enabled[index] = item.optBoolean("enabled", true);
                }
            } catch (Exception error) {
                call.reject("Invalid native menu items", error);
                return;
            }
            WebView shell = bridge.getWebView();
            ViewGroup parent = (ViewGroup) shell.getParent();
            View anchor = new View(bridge.getActivity());
            JSObject bounds = call.getObject("anchor", new JSObject());
            float density = bridge.getContext().getResources().getDisplayMetrics().density;
            int width = Math.max(1, Math.round(
                (float) bounds.optDouble("width", 1) * density
            ));
            int height = Math.max(1, Math.round(
                (float) bounds.optDouble("height", 1) * density
            ));
            parent.addView(anchor, new ViewGroup.LayoutParams(width, height));
            anchor.setX(shell.getX() + Math.round((float) bounds.optDouble("x", 0) * density));
            anchor.setY(shell.getY() + Math.round((float) bounds.optDouble("y", 0) * density));

            PopupMenu popup = new PopupMenu(bridge.getActivity(), anchor, Gravity.END);
            for (int index = 0; index < labels.length; index++) {
                popup.getMenu()
                    .add(0, index, index, labels[index])
                    .setEnabled(enabled[index]);
            }
            AtomicBoolean resolved = new AtomicBoolean();
            popup.setOnMenuItemClickListener(item -> {
                resolved.set(true);
                JSObject result = new JSObject();
                result.put("id", ids[item.getItemId()]);
                call.resolve(result);
                return true;
            });
            popup.setOnDismissListener(ignored -> {
                parent.removeView(anchor);
                if (resolved.compareAndSet(false, true)) call.resolve();
            });
            // addView/setX/setY do not lay the synthetic anchor out
            // synchronously. Showing in the same turn makes PopupMenu observe
            // the parent's origin and clamp itself to the left edge. Posting
            // waits until the anchor has a real window position.
            anchor.post(popup::show);
        });
    }

    static void showPrompt(Bridge bridge, PluginCall call) {
        bridge.getActivity().runOnUiThread(() -> {
            EditText input = new EditText(bridge.getActivity());
            input.setSingleLine(true);
            input.setText(call.getString("value", ""));
            input.selectAll();
            AlertDialog dialog = new AlertDialog.Builder(bridge.getActivity())
                .setTitle(call.getString("title"))
                .setMessage(call.getString("message", ""))
                .setView(input)
                .setNegativeButton(
                    call.getString("cancelLabel", "Cancel"),
                    (ignored, index) -> call.resolve()
                )
                .setPositiveButton(
                    call.getString("confirmLabel", "OK"),
                    (ignored, index) -> {
                        JSObject result = new JSObject();
                        result.put("value", input.getText().toString());
                        call.resolve(result);
                    }
                )
                .create();
            dialog.setOnCancelListener(ignored -> call.resolve());
            dialog.setOnShowListener(ignored -> input.requestFocus());
            dialog.show();
        });
    }

}
