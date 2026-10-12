import { readerDocument, ReaderTheme } from "./readerDocument"

export function readerErrorDocument(sourceUrl: string, error: unknown, theme: ReaderTheme = "system"): string {
  const message = error instanceof Error ? error.message : String(error)
  const escaped = message.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char)
  return readerDocument({ mediaType: "application/octet-stream", title: "Reader mode", byline: "", siteName: new URL(sourceUrl).hostname, sourceUrl, content: `<p data-reader-error role="alert">${escaped}</p>` }, theme)
}
