import { startImageTextBarView, startImageTextWordsView } from "@once/ui-web/imageText/imageTextView"
import type { ImageTextViewBridge } from "@once/ui-web/imageText/imageTextTypes"

declare global {
  interface Window { onceImageTextOverlay: ImageTextViewBridge }
}

// One page serves both of the overlay's views; the hash names which.
if (location.hash === "#bar") startImageTextBarView(window.onceImageTextOverlay)
else startImageTextWordsView(window.onceImageTextOverlay)
