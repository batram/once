package com.zmarn.once;

import android.content.Context;
import android.webkit.CookieManager;
import android.webkit.WebSettings;
import java.net.HttpURLConnection;
import java.net.URL;

/** Fetches with the WebView's cookie jar and user agent, as the page itself would. */
final class LiteImageFetcher implements ImageFetcher {
    private final String userAgent;

    LiteImageFetcher(Context context) { userAgent = WebSettings.getDefaultUserAgent(context); }

    @Override public Response fetch(String url, String referrer) throws Throwable {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setConnectTimeout(30_000);
        connection.setReadTimeout(30_000);
        connection.setRequestProperty("Accept", "image/*");
        connection.setRequestProperty("User-Agent", userAgent);
        if (referrer != null) connection.setRequestProperty("Referer", referrer);
        String cookies = CookieManager.getInstance().getCookie(url);
        if (cookies != null && !cookies.isEmpty()) connection.setRequestProperty("Cookie", cookies);
        int status = connection.getResponseCode();
        return new Response(status, connection.getContentType(), status >= 400 ? connection.getErrorStream() : connection.getInputStream());
    }
}
