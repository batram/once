import { installImageTextAnchor } from "@once/ui-web/imageText/imageTextAnchor"

// Run by the main process in an isolated world of the image's frame (see
// browser/ImageTextHost.ts): hangs the image text selection on the image.
installImageTextAnchor()
