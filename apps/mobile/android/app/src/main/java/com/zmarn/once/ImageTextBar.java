package com.zmarn.once;

import android.app.Activity;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.os.Handler;
import android.os.Looper;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * The bar of an image text selection, as a native view over the page rather
 * than markup in it: what the selection says, Copy and Done. Docked, it sits
 * at the bottom of the page view, where it never trails a scrolling page.
 */
final class ImageTextBar {
    private static final long FEEDBACK_MS = 1600;

    final LinearLayout view;
    private final TextView status;
    private final Button copy;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private String hint = "";

    ImageTextBar(Activity activity, FrameLayout container, boolean docked, Runnable onCopy, Runnable onDone) {
        float density = activity.getResources().getDisplayMetrics().density;
        boolean dark = (activity.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        view = new LinearLayout(activity);
        view.setOrientation(LinearLayout.HORIZONTAL);
        view.setGravity(Gravity.CENTER_VERTICAL);
        GradientDrawable background = new GradientDrawable();
        background.setColor(dark ? Color.rgb(37, 41, 48) : Color.WHITE);
        background.setCornerRadius(12 * density);
        background.setStroke(Math.round(density), dark ? Color.rgb(111, 119, 131) : Color.rgb(184, 190, 199));
        view.setBackground(background);
        view.setElevation(6 * density);
        int padding = Math.round(10 * density);
        view.setPadding(padding + padding / 2, padding / 3, padding / 3, padding / 3);
        // Taps on the bar are its own, never the page's underneath.
        view.setClickable(true);
        status = new TextView(activity);
        status.setText("Recognizing text…");
        status.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        status.setTextColor(dark ? Color.rgb(241, 243, 246) : Color.rgb(32, 36, 43));
        status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        // Docked across the page, the status takes the room the buttons leave.
        view.addView(status, docked ? new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1)
            : new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        copy = new Button(activity, null, android.R.attr.borderlessButtonStyle);
        copy.setText("Copy");
        copy.setVisibility(View.GONE);
        copy.setOnClickListener(ignored -> onCopy.run());
        view.addView(copy);
        Button done = new Button(activity, null, android.R.attr.borderlessButtonStyle);
        done.setText("Done");
        done.setOnClickListener(ignored -> onDone.run());
        view.addView(done);
        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(
            docked ? ViewGroup.LayoutParams.MATCH_PARENT : ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        if (docked) {
            int margin = Math.round(12 * density);
            params.gravity = Gravity.BOTTOM;
            params.setMargins(margin, margin, margin, margin);
        }
        container.addView(view, params);
    }

    /** What the selection says, and whether Copy is offered. */
    void show(String text, boolean offerCopy) {
        handler.removeCallbacksAndMessages(null);
        hint = text;
        status.setText(text);
        copy.setVisibility(offerCopy ? View.VISIBLE : View.GONE);
    }

    /** Says briefly how a copy went, then what it said before. */
    void feedback(String text) {
        handler.removeCallbacksAndMessages(null);
        status.setText(text);
        handler.postDelayed(() -> status.setText(hint), FEEDBACK_MS);
    }

    void remove() {
        handler.removeCallbacksAndMessages(null);
        ViewGroup parent = (ViewGroup) view.getParent();
        if (parent != null) parent.removeView(view);
    }
}
