import { OnceClient } from "@once/app"
import { extractArticle } from "./extractArticle"
import { readerDocument, ReaderTheme } from "./readerDocument"

declare const browser: {
  runtime?: {
    getURL(path: string): string
    sendMessage(message: unknown): Promise<unknown>
  }
}

export class ReaderView {
  private static client: OnceClient | null = null
  private static openDocument: ReaderDocumentOpener | null = null

  static mount(
    client: OnceClient,
    openDocument?: (html: string, sourceUrl: string, target: "_self" | "middle") => Promise<void>
  ): void {
    ReaderView.client = client
    ReaderView.openDocument = openDocument ?? null
  }

  static async open(url: string, target: "_self" | "middle" = "_self"): Promise<void> {
    return ReaderView.openWith(url, target)
  }

  static async openWith(
    url: string,
    target: "_self" | "middle" = "_self",
    openDocument: ReaderDocumentOpener | null = ReaderView.openDocument
  ): Promise<void> {
    if (typeof browser !== "undefined" && browser.runtime?.getURL) {
      await browser.runtime.sendMessage({
        onceCommand: "openReader",
        url,
        active: target !== "middle",
        theme: currentTheme()
      })
      return
    }
    if (!ReaderView.client) throw new Error("ReaderView has not been mounted")
    const fetched = await ReaderView.client.fetchDocument(url)
    const article = extractArticle(fetched.html, fetched.url)
    const html = readerDocument(article, currentTheme())
    if (openDocument) {
      // Keep the requested story URL as reader identity even when fetching
      // followed redirects; article assets still resolve against the final URL.
      await openDocument(html, url, target)
      return
    }
    ReaderView.client.openUrl(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`, target)
  }
}

type ReaderDocumentOpener = (
  html: string,
  sourceUrl: string,
  target: "_self" | "middle"
) => Promise<void>

function currentTheme(): ReaderTheme {
  const explicit = document.body.getAttribute("data-theme")
  return explicit === "dark" || explicit === "light" ? explicit : "system"
}
