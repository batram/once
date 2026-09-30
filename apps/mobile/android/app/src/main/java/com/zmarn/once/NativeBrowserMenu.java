package com.zmarn.once;

import android.app.Activity;
import android.app.Dialog;
import android.content.res.ColorStateList;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
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
    /**
     * The sheet's colours, mirroring the shell's CSS theme tokens so the sheet
     * reads as part of the app rather than a system dialog laid over it.
     */
    private static final class Palette {
        final int sheet, card, text, muted, handle, ripple, icon, accent;

        Palette(boolean dark) {
            sheet = dark ? Color.rgb(40, 42, 54) : Color.rgb(246, 246, 239);
            card = dark ? Color.rgb(56, 58, 89) : Color.WHITE;
            text = dark ? Color.rgb(188, 194, 205) : Color.rgb(39, 38, 54);
            muted = dark ? Color.rgb(120, 126, 142) : Color.rgb(150, 149, 159);
            handle = dark ? Color.rgb(106, 112, 138) : Color.rgb(179, 179, 179);
            ripple = dark ? Color.argb(40, 255, 255, 255) : Color.argb(24, 70, 60, 110);
            icon = dark ? Color.rgb(188, 194, 205) : Color.rgb(105, 104, 121);
            accent = dark ? Color.rgb(90, 104, 200) : Color.rgb(64, 80, 172);
        }
    }

    static void show(Activity activity, PluginCall call, GeckoSession session,
                     boolean canBack, boolean canForward, Runnable back, Runnable forward, Runnable reload, BackgroundMedia media) {
        // The shell resolves its own theme setting (system, light, dark) and
        // says which it landed on; without that, follow the system.
        Boolean requested = call.getBoolean("dark", null);
        boolean dark = requested != null ? requested : (activity.getResources().getConfiguration().uiMode
            & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        Palette palette = new Palette(dark);
        float density = activity.getResources().getDisplayMetrics().density;
        int spacing = Math.round(16 * density);
        int gap = Math.round(8 * density);
        Dialog dialog = new Dialog(activity);
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE);
        LinearLayout content = new LinearLayout(activity);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(spacing, 0, spacing, spacing);
        GradientDrawable background = new GradientDrawable();
        background.setColor(palette.sheet);
        background.setCornerRadii(new float[] { spacing * 2, spacing * 2, spacing * 2, spacing * 2, 0, 0, 0, 0 });
        content.setBackground(background);
        content.addView(new BrowserMenuHandle(activity, dialog, palette.handle), new LinearLayout.LayoutParams(-1, spacing * 3));
        AtomicBoolean settled = new AtomicBoolean();
        dialog.setOnDismissListener(ignored -> { if (settled.compareAndSet(false, true)) call.resolve(); });
        LinearLayout navigation = new LinearLayout(activity);
        boolean open = session != null && session.isOpen();
        navigation.addView(control(activity, palette, "←\nBack", open && canBack, () -> {
            dialog.dismiss(); back.run();
        }), cell(gap, false));
        navigation.addView(control(activity, palette, "→\nForward", open && canForward, () -> {
            dialog.dismiss(); forward.run();
        }), cell(gap, false));
        navigation.addView(control(activity, palette, "↻\nReload", session != null, () -> {
            dialog.dismiss(); reload.run();
        }), cell(gap, false));
        // Find in page: the shell opens its find bar, which searches the page or
        // the reader document, so it needs no Gecko session of its own.
        navigation.addView(control(activity, palette, "⌕\nFind", true, () -> {
            if (settled.compareAndSet(false, true)) call.resolve(new JSObject().put("id", "once:find"));
            dialog.dismiss();
        }), cell(gap, true));
        content.addView(navigation);
        android.widget.Switch backgroundPlayback = new android.widget.Switch(activity);
        backgroundPlayback.setText("Keep media playing in background");
        backgroundPlayback.setTextSize(16);
        backgroundPlayback.setTextColor(palette.text);
        backgroundPlayback.setPadding(spacing, spacing, spacing, spacing);
        backgroundPlayback.setMinHeight(Math.round(56 * density));
        backgroundPlayback.setThumbTintList(new ColorStateList(
            new int[][] { { android.R.attr.state_checked }, {} },
            new int[] { palette.accent, dark ? Color.rgb(188, 194, 205) : Color.WHITE }));
        backgroundPlayback.setTrackTintList(new ColorStateList(
            new int[][] { { android.R.attr.state_checked }, {} },
            new int[] { Color.argb(110, Color.red(palette.accent), Color.green(palette.accent), Color.blue(palette.accent)),
                dark ? Color.rgb(90, 94, 120) : Color.rgb(180, 180, 180) }));
        backgroundPlayback.setChecked(media.isEnabled());
        backgroundPlayback.setOnCheckedChangeListener((button, checked) -> media.setEnabled(checked));
        content.addView(backgroundPlayback, row(gap));
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
                Button row = control(activity, palette, label, item.optBoolean("enabled", true), () -> {
                    if (settled.compareAndSet(false, true)) call.resolve(new JSObject().put("id", id));
                    dialog.dismiss();
                });
                row.setGravity(Gravity.CENTER_VERTICAL | Gravity.START);
                row.setPadding(spacing, 0, spacing, 0);
                setIcon(activity, palette, row, item.optString("iconDataUrl", ""), "once:manage".equals(id));
                String settingsId = item.optString("settingsId", "");
                if (settingsId.isEmpty()) { entries.addView(row, row(gap)); continue; }
                LinearLayout line = new LinearLayout(activity);
                line.addView(row, cell(gap, false));
                Button settings = control(activity, palette, "⚙", true, () -> {
                    if (settled.compareAndSet(false, true)) call.resolve(new JSObject().put("id", settingsId));
                    dialog.dismiss();
                });
                settings.setContentDescription(label + " settings");
                settings.setTextSize(22);
                line.addView(settings, new LinearLayout.LayoutParams(Math.round(56 * density), -2));
                entries.addView(line, row(gap));
            }
        } catch (Exception error) { call.reject("Invalid browser menu items", error); return; }
        String label = "Extensions (" + count + ")";
        Button expand = control(activity, palette, label + "   ⌄", true, () -> {});
        expand.setGravity(Gravity.CENTER_VERTICAL | Gravity.START);
        expand.setPadding(spacing, 0, spacing, 0);
        setIcon(activity, palette, expand, "", false);
        expand.setContentDescription(label + ", collapsed");
        expand.setOnClickListener(ignored -> {
            boolean expanded = entries.getVisibility() != View.VISIBLE;
            entries.setVisibility(expanded ? View.VISIBLE : View.GONE);
            expand.setText(label + (expanded ? "   ⌃" : "   ⌄"));
            expand.setContentDescription(label + (expanded ? ", expanded" : ", collapsed"));
        });
        content.addView(expand, row(gap));
        content.addView(entries);
        ScrollView scroll = new ScrollView(activity);
        scroll.addView(content);
        dialog.setContentView(scroll);
        Window window = dialog.getWindow();
        window.setBackgroundDrawableResource(android.R.color.transparent);
        window.addFlags(android.view.WindowManager.LayoutParams.FLAG_DIM_BEHIND);
        window.setDimAmount(dark ? 0.45f : 0.25f);
        window.setGravity(Gravity.BOTTOM);
        dialog.show();
        window.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    }

    /** An equal-width cell in a horizontal row, with a gap before the next one. */
    private static LinearLayout.LayoutParams cell(int gap, boolean last) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, -2, 1);
        params.setMarginEnd(last ? 0 : gap);
        return params;
    }

    /** A full-width row separated from the one above it. */
    private static LinearLayout.LayoutParams row(int gap) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.topMargin = gap;
        return params;
    }

    private static Button control(Activity activity, Palette palette, String label, boolean enabled, Runnable action) {
        Button button = new Button(activity);
        android.text.SpannableString text = new android.text.SpannableString(label);
        int line = label.indexOf('\n');
        if (line > 0) text.setSpan(new android.text.style.RelativeSizeSpan(1.75f), 0, line, 0);
        button.setText(text);
        button.setContentDescription(label.substring(label.lastIndexOf('\n') + 1));
        button.setTextSize(16);
        button.setTextColor(enabled ? palette.text : palette.muted);
        button.setAllCaps(false);
        GradientDrawable shape = new GradientDrawable();
        shape.setColor(palette.card);
        shape.setCornerRadius(12 * activity.getResources().getDisplayMetrics().density);
        button.setBackground(new RippleDrawable(ColorStateList.valueOf(palette.ripple), shape, null));
        button.setStateListAnimator(null);
        button.setEnabled(enabled);
        button.setMinHeight(Math.round(56 * activity.getResources().getDisplayMetrics().density));
        button.setOnClickListener(ignored -> action.run());
        return button;
    }

    private static void setIcon(Activity activity, Palette palette, Button button, String data, boolean settings) {
        android.graphics.drawable.Drawable icon = activity.getDrawable(settings ?
            android.R.drawable.ic_menu_manage : R.drawable.once_extension_icon).mutate();
        // The fallback glyphs are monochrome outlines; extension bitmaps keep their own colours.
        icon.setTint(palette.icon);
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
