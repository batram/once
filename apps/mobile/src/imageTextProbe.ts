import { installImageTextProbe } from "@once/ui-web/imageText/imageTextProbe"

// Evaluated by mobileImageText.ts in a page's bridge content script (Android),
// where the page's scripts cannot see it; it reports where the long-pressed
// image is to the app's overlay through the script's native port.
installImageTextProbe()
