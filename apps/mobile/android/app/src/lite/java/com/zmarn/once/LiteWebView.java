package com.zmarn.once;

import android.content.Context;
import android.webkit.WebView;

/**
 * A reading page's WebView. It carries the tab marker the DevTools client
 * resolves the page's target by (see LiteNavigation.configure), and reports
 * scroll changes for pull-to-refresh.
 */
final class LiteWebView extends WebView {
    /** Identifies this view among the process's DevTools page targets. */
    final String marker = "once-tab-" + java.util.UUID.randomUUID();

    LiteWebView(Context context) { super(context); }
}
