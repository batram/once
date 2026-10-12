import { installImageTextProbe } from "@once/ui-web/imageText/imageTextProbe"

// Run by the main process in an isolated world of a tab's frame, through the
// DevTools protocol (see browser/ImageTextProbes.ts).
installImageTextProbe()
