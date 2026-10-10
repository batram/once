// Entry for the PDF sandbox page: PDF.js and nothing else. It runs on an
// opaque origin inside a sandboxed frame with no preload and no bridge; the
// shell hands it bytes and answers its asset requests over postMessage.
import { startPdfSandboxRuntime } from "@once/platform-web/pdf-sandbox"

startPdfSandboxRuntime(window)
