package com.zmarn.once;

import android.app.Dialog;
import android.content.Context;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.VelocityTracker;
import android.view.View;
import android.view.ViewConfiguration;
import android.widget.FrameLayout;

/** A generous touch target for dragging the native browser sheet closed. */
final class BrowserMenuHandle extends FrameLayout {
    private final Dialog dialog;
    private final float density;
    private final int slop;
    private VelocityTracker velocity;
    private float startY;
    private boolean dragging;

    BrowserMenuHandle(Context context, Dialog dialog) {
        super(context);
        this.dialog = dialog;
        density = getResources().getDisplayMetrics().density;
        slop = ViewConfiguration.get(context).getScaledTouchSlop();
        View pill = new View(context);
        GradientDrawable shape = new GradientDrawable();
        shape.setColor(Color.rgb(155, 154, 164));
        shape.setCornerRadius(16 * density);
        pill.setBackground(shape);
        addView(pill, new LayoutParams(Math.round(48 * density), Math.round(5 * density), Gravity.CENTER));
        setContentDescription("Close browser menu");
        setFocusable(true);
        setOnClickListener(ignored -> dialog.dismiss());
    }

    @Override public boolean onTouchEvent(MotionEvent event) {
        View sheet = dialog.getWindow().getDecorView();
        switch (event.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                sheet.animate().cancel();
                startY = event.getRawY() - sheet.getTranslationY();
                dragging = false;
                recycleVelocity();
                velocity = VelocityTracker.obtain();
                getParent().requestDisallowInterceptTouchEvent(true);
                break;
            case MotionEvent.ACTION_MOVE:
                if (Math.abs(event.getRawY() - startY) > slop) dragging = true;
                if (dragging) sheet.setTranslationY(Math.max(0, event.getRawY() - startY));
                break;
            case MotionEvent.ACTION_UP:
                if (velocity != null) {
                    track(event);
                    velocity.computeCurrentVelocity(1000);
                }
                boolean dismiss = dragging && (sheet.getTranslationY() > Math.min(96 * density, sheet.getHeight() * 0.25f)
                    || (sheet.getTranslationY() > slop && velocity != null && velocity.getYVelocity() > 600 * density));
                recycleVelocity();
                getParent().requestDisallowInterceptTouchEvent(false);
                if (!dragging) { performClick(); return true; }
                settle(sheet, dismiss);
                return true;
            case MotionEvent.ACTION_CANCEL:
                recycleVelocity();
                getParent().requestDisallowInterceptTouchEvent(false);
                settle(sheet, false);
                return true;
        }
        track(event);
        return true;
    }

    private void track(MotionEvent event) {
        if (velocity == null) return;
        // The sheet itself moves, so measure the finger in screen coordinates.
        MotionEvent absolute = MotionEvent.obtain(event);
        absolute.offsetLocation(event.getRawX() - event.getX(), event.getRawY() - event.getY());
        velocity.addMovement(absolute);
        absolute.recycle();
    }

    @Override public boolean performClick() { super.performClick(); return true; }

    private void settle(View sheet, boolean dismiss) {
        sheet.animate().translationY(dismiss ? sheet.getHeight() : 0).setDuration(180)
            .withEndAction(dismiss ? dialog::dismiss : null).start();
    }

    private void recycleVelocity() {
        if (velocity != null) { velocity.recycle(); velocity = null; }
    }

    @Override protected void onDetachedFromWindow() {
        recycleVelocity();
        super.onDetachedFromWindow();
    }
}
