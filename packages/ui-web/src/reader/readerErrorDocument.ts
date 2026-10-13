import { readerDocument, ReaderTheme } from "./readerDocument"

/** The reader page for an article that could not be read; "Try again" asks the host to read it afresh. */
export function readerErrorDocument(sourceUrl: string, error: unknown, theme: ReaderTheme = "system"): string {
  const message = error instanceof Error ? error.message : String(error)
  const retry = `<p><a data-reader-retry href="${escape(`once-reader://${new URL(sourceUrl).toString()}`)}">Try again</a></p>`
  return readerDocument({ mediaType: "application/octet-stream", title: "Reader mode", byline: "", siteName: new URL(sourceUrl).hostname, sourceUrl, content: `<p data-reader-error role="alert">${escape(message)}</p>${retry}` }, theme)
}

function escape(text: string): string {
  return text.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char)
}
