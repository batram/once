// Entry for the PDF sandbox page in the extension builds: PDF.js and nothing
// else. On Chrome the page is a manifest `sandbox` page with its own policy;
// Firefox's MV2 extension CSP permits the blob worker it builds. Both hosts
// keep the frame opaque with sandbox="allow-scripts".
import { startPdfSandboxRuntime } from "@once/platform-web/pdf-sandbox"

startPdfSandboxRuntime(window)
