package com.zmarn.once;

import java.io.InputStream;

/**
 * Fetches an image the way the engine's pages would: with their cookies and
 * referrer, so Copy/Share/Save image and image text recognition get the
 * bytes a page shows. Blocking; never called on the UI thread.
 */
interface ImageFetcher {
    final class Response implements AutoCloseable {
        final int status;
        final String contentType;
        final InputStream body;

        Response(int status, String contentType, InputStream body) {
            this.status = status;
            this.contentType = contentType;
            this.body = body;
        }

        @Override public void close() throws java.io.IOException { if (body != null) body.close(); }
    }

    Response fetch(String url, String referrer) throws Throwable;
}
