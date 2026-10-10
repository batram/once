// The parser worker's emitted location, kept apart so that ordinary page
// retrieval, and Node, never resolve the bundler-only asset query.
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?pdf-worker"

export const pdfWorkerUrl: string = workerUrl
