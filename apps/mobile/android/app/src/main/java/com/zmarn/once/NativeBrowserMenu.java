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

    /** The sheet a row left up for its own menu (which device to send to); that menu closes it. */
    private static java.lang.ref.WeakReference<Dialog> held = new java.lang.ref.WeakReference<>(null);

    /** The held sheet, while it is still on screen. */
    static Dialog held() {
        Dialog dialog = held.get();
        return dialog != null && dialog.isShowing() ? dialog : null;
    }

    /** Closes the held sheet, if one is up. */
    static void closeHeld() {
        Dialog dialog = held();
        held = new java.lang.ref.WeakReference<>(null);
        if (dialog != null) dialog.dismiss();
    }

    static void show(Activity activity, PluginCall call, GeckoSession session,
                     boolean canBack, boolean canForward, Runnable back, Runnable forward, Runnable reload, BackgroundMedia media,
                     DesktopSite desktop) {
        // The shell resolves its own theme setting (system, light, dark) and
        // says which it landed on; without that, follow the system.
        Boolean requested = call.getBoolean("dark", null);
        boolean dark = requested != null ? requested : (activity.getResources().getConfiguration().uiMode
            & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        Palette palette = new Palette(dark);
        float density = activity.getResources().getDisplayMetrics().density;
        int spacing = Math.round(16 * density);
        int gap = Math.round(8 * density);
        // One height for every list entry (switch, extension rows, gears,
        // expander) so the sheet reads as aligned rows rather than mixed buttons.
        int entry = Math.round(48 * density);
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
        // Square tiles like iOS's: an outline icon over a one-line label, as tall
        // as each of the five is wide.
        int tileHeight = (activity.getResources().getDisplayMetrics().widthPixels - 2 * spacing - 4 * gap) / 5;
        navigation.addView(tile(activity, palette, R.drawable.browser_back, "Back", open && canBack, () -> {
            dialog.dismiss(); back.run();
        }), cell(gap, false, tileHeight));
        navigation.addView(tile(activity, palette, R.drawable.browser_forward, "Forward", open && canForward, () -> {
            dialog.dismiss(); forward.run();
        }), cell(gap, false, tileHeight));
        navigation.addView(tile(activity, palette, R.drawable.browser_reload, "Reload", session != null, () -> {
            dialog.dismiss(); reload.run();
        }), cell(gap, false, tileHeight));
        // Find in page: the shell opens its find bar, which searches the page or
        // the reader document, so it needs no Gecko session of its own.
        navigation.addView(tile(activity, palette, R.drawable.browser_find, "Find", true, () -> {
            if (settled.compareAndSet(false, true)) call.resolve(new JSObject().put("id", "once:find"));
            dialog.dismiss();
        }), cell(gap, false, tileHeight));
        // Closes the tab being read; the shell owns its tabs.
        navigation.addView(tile(activity, palette, R.drawable.browser_close, "Close", true, () -> {
            if (settled.compareAndSet(false, true)) call.resolve(new JSObject().put("id", "once:close-tab"));
            dialog.dismiss();
        }), cell(gap, true, tileHeight));
        // One label size for the row, the largest at which the longest label
        // ("Forward") still fits its tile with room to either side.
        int tileWidth = (activity.getResources().getDisplayMetrics().widthPixels - 2 * spacing - 4 * gap) / 5
            - 2 * Math.round(6 * density);
        float labelSize = 13;
        android.graphics.Paint measure = new android.graphics.Paint();
        for (int index = 0; index < navigation.getChildCount(); index++) {
            Button tile = (Button) navigation.getChildAt(index);
            measure.setTextSize(labelSize * activity.getResources().getDisplayMetrics().scaledDensity);
            float width = measure.measureText(tile.getText().toString());
            if (width > tileWidth) labelSize = labelSize * tileWidth / width;
        }
        for (int index = 0; index < navigation.getChildCount(); index++) {
            ((Button) navigation.getChildAt(index)).setTextSize(labelSize);
        }
        content.addView(navigation);
        content.addView(toggle(activity, palette, dark, "Keep media playing in background", media.isEnabled(),
            media::setEnabled), row(gap, entry));
        // Reloads the page in the new mode; the sheet closes once the switch
        // has moved, so the reloaded page shows.
        content.addView(toggle(activity, palette, dark, "Desktop site", desktop.isEnabled(), checked -> {
            desktop.choose(checked);
            desktop.apply(session);
            content.postDelayed(() -> { dialog.dismiss(); if (session != null) reload.run(); }, 200);
        }), row(gap, entry));
        // Actions on the page itself (send it to another device) sit below the
        // media switch, as on iOS, not inside the collapsed extensions.
        LinearLayout pageActions = new LinearLayout(activity);
        pageActions.setOrientation(LinearLayout.VERTICAL);
        content.addView(pageActions);
        LinearLayout entries = new LinearLayout(activity);
        entries.setOrientation(LinearLayout.VERTICAL);
        entries.setVisibility(View.GONE);
        JSArray items = call.getArray("items", new JSArray());
        int count = 0;
        try {
            for (int index = 0; index < items.length(); index++) {
                JSONObject item = items.getJSONObject(index);
                String id = item.getString("id");
                boolean page = "page".equals(item.optString("placement", ""));
                if (!"once:manage".equals(id) && !page) count++;
                String label = item.getString("label");
                boolean holds = item.optBoolean("holdsSheet", false);
                Button row = control(activity, palette, label, item.optBoolean("enabled", true), () -> {
                    if (!settled.compareAndSet(false, true)) return;
                    // A row with a menu of its own answers now and stays up
                    // beneath that menu, which closes both.
                    if (holds) held = new java.lang.ref.WeakReference<>(dialog);
                    call.resolve(new JSObject().put("id", id));
                    if (!holds) dialog.dismiss();
                });
                row.setGravity(Gravity.CENTER_VERTICAL | Gravity.START);
                row.setPadding(spacing, 0, spacing, 0);
                // A long add-on name must not wrap: it would push the row taller
                // than its gear and spill into the entry below.
                row.setSingleLine(true);
                row.setEllipsize(android.text.TextUtils.TruncateAt.END);
                if (page) { pageActions.addView(row, row(gap, entry)); continue; }
                setIcon(activity, palette, row, item.optString("iconDataUrl", ""), "once:manage".equals(id));
                String settingsId = item.optString("settingsId", "");
                if (settingsId.isEmpty()) { entries.addView(row, row(gap, entry)); continue; }
                LinearLayout line = new LinearLayout(activity);
                line.addView(row, cell(gap, false, entry));
                Button settings = control(activity, palette, "⚙", true, () -> {
                    if (settled.compareAndSet(false, true)) call.resolve(new JSObject().put("id", settingsId));
                    dialog.dismiss();
                });
                settings.setContentDescription(label + " settings");
                settings.setTextSize(22);
                settings.setPadding(0, 0, 0, 0);
                line.addView(settings, new LinearLayout.LayoutParams(entry, entry));
                entries.addView(line, row(gap, entry));
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
        content.addView(expand, row(gap, entry));
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
        return cell(gap, last, -2);
    }

    private static LinearLayout.LayoutParams cell(int gap, boolean last, int height) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, height, 1);
        params.setMarginEnd(last ? 0 : gap);
        return params;
    }

    /** A full-width row of a fixed height, separated from the one above it. */
    /** A switch on a card like the rows around it (and iOS's); the whole row toggles. */
    private static android.widget.Switch toggle(Activity activity, Palette palette, boolean dark, String label,
                                                boolean checked, java.util.function.Consumer<Boolean> changed) {
        float density = activity.getResources().getDisplayMetrics().density;
        int spacing = Math.round(16 * density);
        android.widget.Switch toggle = new android.widget.Switch(activity);
        toggle.setText(label);
        toggle.setTextSize(16);
        toggle.setTextColor(palette.text);
        toggle.setPadding(spacing, 0, spacing, 0);
        toggle.setGravity(Gravity.CENTER_VERTICAL);
        GradientDrawable card = new GradientDrawable();
        card.setColor(palette.card);
        card.setCornerRadius(12 * density);
        toggle.setBackground(new RippleDrawable(ColorStateList.valueOf(palette.ripple), card, null));
        toggle.setThumbTintList(new ColorStateList(
            new int[][] { { android.R.attr.state_checked }, {} },
            new int[] { palette.accent, dark ? Color.rgb(188, 194, 205) : Color.WHITE }));
        toggle.setTrackTintList(new ColorStateList(
            new int[][] { { android.R.attr.state_checked }, {} },
            new int[] { Color.argb(110, Color.red(palette.accent), Color.green(palette.accent), Color.blue(palette.accent)),
                dark ? Color.rgb(90, 94, 120) : Color.rgb(180, 180, 180) }));
        toggle.setChecked(checked);
        toggle.setOnCheckedChangeListener((button, value) -> changed.accept(value));
        return toggle;
    }

    private static LinearLayout.LayoutParams row(int gap, int height) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, height);
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
        // Fixed-height rows size themselves; the stock Button minimum would
        // otherwise force every control to the tall default.
        button.setMinHeight(0);
        button.setMinimumHeight(0);
        int inset = Math.round(8 * activity.getResources().getDisplayMetrics().density);
        button.setPadding(inset, inset, inset, inset);
        button.setOnClickListener(clicked -> {
            int[] at = new int[2];
            clicked.getLocationOnScreen(at);
            NativeSurfaceDialogs.touched(at[0] + clicked.getWidth() / 2f, at[1] + clicked.getHeight() / 2f);
            action.run();
        });
        return button;
    }

    /** A navigation tile: the outline icon over its label, dimmed when it cannot act. */
    private static Button tile(Activity activity, Palette palette, int icon, String label, boolean enabled, Runnable action) {
        Button button = control(activity, palette, label, enabled, action);
        float density = activity.getResources().getDisplayMetrics().density;
        android.graphics.drawable.Drawable glyph = activity.getDrawable(icon).mutate();
        int size = Math.round(26 * density);
        glyph.setBounds(0, 0, size, size);
        glyph.setTint(enabled ? palette.text : palette.muted);
        button.setCompoundDrawables(null, glyph, null, null);
        // The glyph's own margin and the label's ascent already part the two;
        // overlap their empty edges so they read as one unit, as on iOS.
        button.setCompoundDrawablePadding(-Math.round(6 * density));
        button.setIncludeFontPadding(false);
        button.setSingleLine(true);
        button.setGravity(Gravity.CENTER);
        // Regular weight, as iOS draws these labels; a Button defaults to medium.
        // The theme's button weight wins over a plain typeface from Android 9 on.
        button.setTypeface(android.os.Build.VERSION.SDK_INT >= 28
            ? android.graphics.Typeface.create(android.graphics.Typeface.DEFAULT, 400, false)
            : android.graphics.Typeface.DEFAULT);
        int inset = Math.round(2 * density);
        button.setPadding(inset, Math.round(7 * density), inset, Math.round(2 * density));
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
