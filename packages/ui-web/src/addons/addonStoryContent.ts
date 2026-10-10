import { OnceClient } from "@once/app"
import { AddonStoryContent } from "@once/core"
import { articleFromStoredContent, extractArticle } from "../reader/extractArticle"

/**
 * The article an add-on reads: saved content first, then the page as an open
 * tab or the reading view shows it (scripts run, so what the reader sees), and
 * only then a fetch of the page. A fetch that finds nothing readable says how
 * to get further: open the page and ask again.
 */
export async function addonStoryContent(client: OnceClient, href: string, signal?: AbortSignal, fresh = false): Promise<AddonStoryContent> {
  const stored = fresh ? null : await client.getStoryContent(href)
  signal?.throwIfAborted()
  let article
  let origin: AddonStoryContent["origin"]
  if (stored) {
    article = articleFromStoredContent(stored.html, stored.meta, href)
    origin = "stored"
  } else {
    const live = await client.livePageHtml(href).catch(() => null)
    signal?.throwIfAborted()
    if (live && !isImageDocument(live.html)) {
      article = extractArticle(live.html, live.url)
      origin = "live"
    } else {
      let page
      try {
        page = await client.fetchDocument(href)
        signal?.throwIfAborted()
        article = extractArticle(page.html, page.url, page.mediaType)
      } catch (error) {
        if (signal?.aborted) throw error
        const reason = error instanceof Error ? error.message : String(error)
        throw new Error(`${reason.replace(/\.?$/, ".")} Open the page, then choose Read the page to use it as shown there.`)
      }
      origin = "page"
    }
  }
  const doc = new DOMParser().parseFromString(article.content, "text/html")
  for (const element of doc.querySelectorAll("p,li,h1,h2,h3,h4,br,pre,blockquote")) element.append(doc.createTextNode("\n"))
  const text = (doc.body.textContent ?? "").replace(/[ \t]+/g, " ").replace(/\n\s*\n/g, "\n\n").trim()
  if (!text) throw new Error("No readable article content was found. Open the page, then choose Read the page to use it as shown there.")
  return { text: text.slice(0, 64_000), title: article.title, sourceUrl: article.sourceUrl, origin, truncated: text.length > 64_000 }
}

function isImageDocument(html: string): boolean {
  const doc = new DOMParser().parseFromString(html, "text/html")
  return Boolean(doc.body.querySelector("img")) && !(doc.body.textContent ?? "").trim()
}
