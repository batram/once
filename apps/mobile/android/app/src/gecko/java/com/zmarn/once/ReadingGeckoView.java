package com.zmarn.once;

import android.content.Context;
import android.view.MotionEvent;
import org.mozilla.geckoview.GeckoView;
import org.mozilla.geckoview.PanZoomController;

/**
 * The reading surface's GeckoView. It remembers how Gecko handled the current
 * touch gesture, so pull-to-refresh only takes a drag the browser itself would
 * overscroll at the top of the page, as Firefox for Android does, and never one
 * that page content consumed (preventDefault or touch-action): a map, a slider,
 * or the image text overlay's selection handles.
 */
final class ReadingGeckoView extends GeckoView {
    private int gesture;
    private boolean pullAllowed;

    ReadingGeckoView(Context context) { super(context); }

    /** Whether the current gesture may become pull-to-refresh; false until Gecko has answered. */
    boolean allowsPullToRefresh() { return pullAllowed; }

    @Override
    public boolean onTouchEvent(MotionEvent event) {
        if (event.getActionMasked() != MotionEvent.ACTION_DOWN) return super.onTouchEvent(event);
        int current = ++gesture;
        pullAllowed = false;
        // Handles the event exactly as onTouchEvent does, and reports the verdict.
        onTouchEventForDetailResult(event).accept(detail -> {
            if (current != gesture || detail == null) return;
            pullAllowed = detail.handledResult() != PanZoomController.INPUT_RESULT_HANDLED_CONTENT
                && (detail.scrollableDirections() & PanZoomController.SCROLLABLE_FLAG_TOP) == 0
                && (detail.overscrollDirections() & PanZoomController.OVERSCROLL_FLAG_VERTICAL) != 0;
        });
        return true;
    }
}
