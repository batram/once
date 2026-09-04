import { OnceClient } from "@once/app"
import { articleFromStoredContent, extractArticle, ReaderArticle } from "./extractArticle"
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
    if (openDocument) ReaderView.openDocument = openDocument
  }

  static async open(url: string, target: "_self" | "middle" = "_self"): Promise<void> {
    return ReaderView.openWith(url, target)
  }

  /**
   * An article Once already holds for this URL is shown as it is, without a
   * request: that is what makes a stored story readable offline. Only a story
   * without one fetches the page.
   */
  static async openWith(
    url: string,
    target: "_self" | "middle" = "_self",
    openDocument: ReaderDocumentOpener | null = ReaderView.openDocument
  ): Promise<void> {
    const stored = ReaderView.client
      ? await storedArticle(ReaderView.client, url)
      : null
    if (typeof browser !== "undefined" && browser.runtime?.getURL) {
      if (stored) {
        await browser.runtime.sendMessage({
          onceCommand: "openStoredReader",
          html: readerDocument(stored, currentTheme()),
          sourceUrl: url,
          active: target !== "middle"
        })
        return
      }
      await browser.runtime.sendMessage({
        onceCommand: "openReader",
        url,
        active: target !== "middle",
        theme: currentTheme()
      })
      return
    }
    if (!ReaderView.client) throw new Error("ReaderView has not been mounted")
    let article = stored
    if (!article) {
      const fetched = await ReaderView.client.fetchDocument(url)
      article = extractArticle(fetched.html, fetched.url, fetched.mediaType)
    }
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

/** The stored article for the story this URL belongs to, if there is one. */
export async function storedArticle(
  client: OnceClient,
  url: string
): Promise<ReaderArticle | null> {
  let story
  try {
    story = await client.findStoryByUrl(url)
  } catch (error) {
    console.warn("Stored content lookup failed; fetching instead", error)
    return null
  }
  if (!story?.has_content()) return null
  const content = await client.getStoryContent(story.href)
  if (!content) return null
  return articleFromStoredContent(content.html, content.meta, story.href, story.title)
}

function currentTheme(): ReaderTheme {
  const explicit = document.body.getAttribute("data-theme")
  return explicit === "dark" || explicit === "light" ? explicit : "system"
}
