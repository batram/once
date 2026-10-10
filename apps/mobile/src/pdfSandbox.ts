// Entry for the PDF sandbox page on mobile: PDF.js and nothing else. The page
// is a static asset beside the app, loaded in a sandboxed frame, so it has an
// opaque origin, its own policy, and no bridge to anything.
import { startPdfSandboxRuntime } from "@once/platform-web/pdf-sandbox"

startPdfSandboxRuntime(window)
