package com.zmarn.once;

import org.mozilla.geckoview.GeckoRuntime;
import org.mozilla.geckoview.GeckoWebExecutor;
import org.mozilla.geckoview.WebRequest;
import org.mozilla.geckoview.WebResponse;

/** Fetches through Gecko, with the profile's cookies, as Copy image in Firefox does. */
final class GeckoImageFetcher implements ImageFetcher {
    private static final long FETCH_TIMEOUT_MS = 30000;
    private final GeckoRuntime runtime;

    GeckoImageFetcher(GeckoRuntime runtime) { this.runtime = runtime; }

    @Override public Response fetch(String url, String referrer) throws Throwable {
        WebRequest.Builder request = new WebRequest.Builder(url).header("Accept", "image/*");
        if (referrer != null) request.referrer(referrer);
        // poll blocks, so this runs on a worker thread, never the UI thread.
        WebResponse response = new GeckoWebExecutor(runtime).fetch(request.build()).poll(FETCH_TIMEOUT_MS);
        String type = response.headers.get("Content-Type");
        if (type == null) type = response.headers.get("content-type");
        return new Response(response.statusCode, type, response.body);
    }
}
