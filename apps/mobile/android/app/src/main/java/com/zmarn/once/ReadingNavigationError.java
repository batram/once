package com.zmarn.once;

import org.mozilla.geckoview.WebRequestError;

final class ReadingNavigationError {
    static String describe(WebRequestError error) {
        switch (error.category) {
            case WebRequestError.ERROR_CATEGORY_SECURITY:
                return "TLS certificate validation failed";
            case WebRequestError.ERROR_CATEGORY_URI:
                return "The address could not be resolved";
            case WebRequestError.ERROR_CATEGORY_NETWORK:
                return "The network request failed";
            case WebRequestError.ERROR_CATEGORY_CONTENT:
                return "The content could not be loaded";
            default:
                return "The page could not be loaded";
        }
    }

}
