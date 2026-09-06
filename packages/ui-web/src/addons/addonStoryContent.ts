import { OnceClient } from "@once/app"
import { AddonStoryContent } from "@once/core"
import { articleFromStoredContent, extractArticle } from "../reader/extractArticle"

export async function addonStoryContent(client: OnceClient, href: string, signal?: AbortSignal): Promise<AddonStoryContent> {
  const stored = await client.getStoryContent(href)
  signal?.throwIfAborted()
  let article
  if (stored) article = articleFromStoredContent(stored.html, stored.meta, href)
  else {
    const page = await client.fetchDocument(href)
    signal?.throwIfAborted()
    article = extractArticle(page.html, page.url, page.mediaType)
  }
  const doc = new DOMParser().parseFromString(article.content, "text/html")
  for (const element of doc.querySelectorAll("p,li,h1,h2,h3,h4,br,pre,blockquote")) element.append(doc.createTextNode("\n"))
  const text = (doc.body.textContent ?? "").replace(/[ \t]+/g, " ").replace(/\n\s*\n/g, "\n\n").trim()
  if (!text) throw new Error("No readable article content was found")
  return { text: text.slice(0, 64_000), title: article.title, sourceUrl: article.sourceUrl, origin: stored ? "stored" : "page", truncated: text.length > 64_000 }
}
