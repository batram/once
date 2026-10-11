import { installImageTextOverlay } from "@once/ui-web/imageText/imageTextOverlay"

// Evaluated in a page by mobileImageText.ts to show recognized words over the
// long-pressed image for selection and copying, with GeckoView's native touch
// selection over a text layer.
installImageTextOverlay({ textLayer: true })
