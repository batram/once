package com.zmarn.once;

import android.content.Context;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.view.View;
import android.widget.FrameLayout;

import androidx.appcompat.widget.AppCompatTextView;

/** Small native overlay: updating progress never changes the browser viewport. */
final class ReadingLoadStatus extends AppCompatTextView {
    ReadingLoadStatus(Context context) {
        super(context);
        setTextSize(12);
        setTextColor(Color.WHITE);
        setPadding(dp(10), dp(6), dp(10), dp(6));
        GradientDrawable background = new GradientDrawable();
        background.setColor(Color.argb(225, 40, 40, 45));
        background.setCornerRadius(dp(8));
        setBackground(background);
        setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_YES);
        setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        setVisibility(View.GONE);
    }

    FrameLayout.LayoutParams layoutParams() {
        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(-2, -2, Gravity.BOTTOM | Gravity.RIGHT);
        params.setMargins(dp(8), dp(8), dp(8), dp(8));
        return params;
    }

    void show(String text) {
        if (!text.contentEquals(getText())) setText(text);
        setVisibility(View.VISIBLE);
    }

    void hide() { setVisibility(View.GONE); }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
}
