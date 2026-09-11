package com.zmarn.once;

import android.app.Activity;
import android.app.Dialog;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.content.res.ColorStateList;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONObject;
import org.mozilla.geckoview.GeckoSession;

/** Native browser sheet with an inline expandable extension list. */
final class NativeBrowserMenu {
    static void show(Activity activity, PluginCall call, GeckoSession session,
                     boolean canBack, boolean canForward, Runnable reload, BackgroundMedia media) {
        Dialog dialog = new Dialog(activity);
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE);
        LinearLayout content = new LinearLayout(activity);
        content.setOrientation(LinearLayout.VERTICAL);
        int spacing = Math.round(16 * activity.getResources().getDisplayMetrics().density);
        content.setPadding(spacing, 0, spacing, spacing);
        GradientDrawable background = new GradientDrawable();
        background.setColor(Color.rgb(247, 246, 251));
        background.setCornerRadius(spacing * 2);
        content.setBackground(background);
        content.addView(new BrowserMenuHandle(activity, dialog), new LinearLayout.LayoutParams(-1, spacing * 3));
        AtomicBoolean settled = new AtomicBoolean();
        dialog.setOnDismissListener(ignored -> { if (settled.compareAndSet(false, true)) call.resolve(); });
        LinearLayout navigation = new LinearLayout(activity);
        boolean open = session != null && session.isOpen();
        navigation.addView(control(activity, "←\nBack", open && canBack, () -> {
            dialog.dismiss(); session.goBack();
        }), new LinearLayout.LayoutParams(0, -2, 1));
        navigation.addView(control(activity, "→\nForward", open && canForward, () -> {
            dialog.dismiss(); session.goForward();
        }), new LinearLayout.LayoutParams(0, -2, 1));
        navigation.addView(control(activity, "↻\nReload", session != null, () -> {
            dialog.dismiss(); reload.run();
        }), new LinearLayout.LayoutParams(0, -2, 1));
        content.addView(navigation);
        android.widget.Switch backgroundPlayback = new android.widget.Switch(activity);
        backgroundPlayback.setText("Keep media playing in background");
        backgroundPlayback.setTextSize(16);
        backgroundPlayback.setPadding(spacing, spacing, spacing, spacing);
        backgroundPlayback.setChecked(media.isEnabled());
        backgroundPlayback.setOnCheckedChangeListener((button, checked) -> media.setEnabled(checked));
        content.addView(backgroundPlayback, new LinearLayout.LayoutParams(-1, -2));
        LinearLayout entries = new LinearLayout(activity);
        entries.setOrientation(LinearLayout.VERTICAL);
        entries.setVisibility(View.GONE);
        JSArray items = call.getArray("items", new JSArray());
        int count = 0;
        try {
            for (int index = 0; index < items.length(); index++) {
                JSONObject item = items.getJSONObject(index);
                String id = item.getString("id");
                if (!"once:manage".equals(id)) count++;
                String label = item.getString("label");
                Button row = control(activity, label, item.optBoolean("enabled", true), () -> {
                    if (settled.compareAndSet(false, true)) call.resolve(new JSObject().put("id", id));
                    dialog.dismiss();
                });
                row.setGravity(Gravity.CENTER_VERTICAL | Gravity.START);
                row.setPadding(spacing, 0, spacing, 0);
                setIcon(activity, row, item.optString("iconDataUrl", ""), "once:manage".equals(id));
                String settingsId = item.optString("settingsId", "");
                if (settingsId.isEmpty()) { entries.addView(row, new LinearLayout.LayoutParams(-1, -2)); continue; }
                LinearLayout line = new LinearLayout(activity);
                line.addView(row, new LinearLayout.LayoutParams(0, -2, 1));
                Button settings = control(activity, "⚙", true, () -> {
                    if (settled.compareAndSet(false, true)) call.resolve(new JSObject().put("id", settingsId));
                    dialog.dismiss();
                });
                settings.setContentDescription(label + " settings");
                settings.setTextSize(22);
                line.addView(settings, new LinearLayout.LayoutParams(Math.round(56 * activity.getResources().getDisplayMetrics().density), -2));
                entries.addView(line, new LinearLayout.LayoutParams(-1, -2));
            }
        } catch (Exception error) { call.reject("Invalid browser menu items", error); return; }
        String label = "Extensions (" + count + ")";
        Button expand = control(activity, label + "   ⌄", true, () -> {});
        expand.setGravity(Gravity.CENTER_VERTICAL | Gravity.START);
        expand.setPadding(spacing, 0, spacing, 0);
        setIcon(activity, expand, "", false);
        expand.setContentDescription(label + ", collapsed");
        expand.setOnClickListener(ignored -> {
            boolean expanded = entries.getVisibility() != View.VISIBLE;
            entries.setVisibility(expanded ? View.VISIBLE : View.GONE);
            expand.setText(label + (expanded ? "   ⌃" : "   ⌄"));
            expand.setContentDescription(label + (expanded ? ", expanded" : ", collapsed"));
        });
        content.addView(expand, new LinearLayout.LayoutParams(-1, -2));
        content.addView(entries);
        ScrollView scroll = new ScrollView(activity);
        scroll.addView(content);
        dialog.setContentView(scroll);
        Window window = dialog.getWindow();
        window.setBackgroundDrawableResource(android.R.color.transparent);
        window.addFlags(android.view.WindowManager.LayoutParams.FLAG_DIM_BEHIND);
        window.setDimAmount(0.25f);
        window.setGravity(Gravity.BOTTOM);
        dialog.show();
        window.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    }

    private static Button control(Activity activity, String label, boolean enabled, Runnable action) {
        Button button = new Button(activity);
        android.text.SpannableString text = new android.text.SpannableString(label);
        int line = label.indexOf('\n');
        if (line > 0) text.setSpan(new android.text.style.RelativeSizeSpan(1.75f), 0, line, 0);
        button.setText(text);
        button.setContentDescription(label.substring(label.lastIndexOf('\n') + 1));
        button.setTextSize(16);
        button.setTextColor(enabled ? Color.rgb(39, 38, 54) : Color.rgb(150, 149, 159));
        button.setAllCaps(false);
        GradientDrawable shape = new GradientDrawable();
        shape.setColor(Color.WHITE);
        shape.setCornerRadius(12 * activity.getResources().getDisplayMetrics().density);
        button.setBackground(new RippleDrawable(ColorStateList.valueOf(Color.argb(24, 70, 60, 110)), shape, null));
        button.setStateListAnimator(null);
        button.setEnabled(enabled);
        button.setMinHeight(Math.round(56 * activity.getResources().getDisplayMetrics().density));
        button.setOnClickListener(ignored -> action.run());
        return button;
    }

    private static void setIcon(Activity activity, Button button, String data, boolean settings) {
        android.graphics.drawable.Drawable icon = activity.getDrawable(settings ?
            android.R.drawable.ic_menu_manage : R.drawable.once_extension_icon);
        String prefix = "data:image/png;base64,";
        if (data.startsWith(prefix) && data.length() < 65536) {
            try {
                byte[] bytes = android.util.Base64.decode(data.substring(prefix.length()), android.util.Base64.DEFAULT);
                android.graphics.Bitmap bitmap = android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
                if (bitmap != null) icon = new android.graphics.drawable.BitmapDrawable(activity.getResources(), bitmap);
            } catch (IllegalArgumentException ignored) { /* Retain the fallback icon. */ }
        }
        int size = Math.round(20 * activity.getResources().getDisplayMetrics().density);
        icon.setBounds(0, 0, size, size);
        button.setCompoundDrawablesRelative(icon, null, null, null);
        button.setCompoundDrawablePadding(Math.round(12 * activity.getResources().getDisplayMetrics().density));
    }
}
