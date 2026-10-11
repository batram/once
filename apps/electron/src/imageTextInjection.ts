import { installImageTextOverlay } from "@once/ui-web/imageText/imageTextOverlay"

// Injected into the image's document by the main process (see browser/ImageText.ts)
// to show recognized words over the image for selection and copying.
installImageTextOverlay()
