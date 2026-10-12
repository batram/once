import { installImageTextOverlay } from "@once/ui-web/imageText/imageTextOverlay"

// Evaluated in a page by mobileImageText.ts to show recognized words over the
// long-pressed image for selection and copying, with GeckoView's native touch
// selection over a text layer. Its bar is the app's own native view
// (ImageTextBar.java): what it shows goes there through the bridge content
// script's port, where this runs.

installImageTextOverlay({
  textLayer: true,
  // Looked up on each report: the content script owns it (see content.js).
  bar: (token, state) => (globalThis as { __onceImageTextPush?: (payload: string) => void })
    .__onceImageTextPush?.(JSON.stringify({ token, bar: state }))
})
