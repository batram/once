import { Readability } from "@mozilla/readability"
import { StoredContentMeta } from "@once/core"

export interface ReaderArticle {
  title: string
  byline: string
  siteName: string
  content: string
  sourceUrl: string
}

/**
 * An article from html Once stored earlier: a feed's text or a page already
 * extracted. Sanitized again on the way out, since what a feed included was
 * never run through the reader, and relative links resolve against the story.
 */
export function articleFromStoredContent(
  html: string,
  meta: StoredContentMeta,
  sourceUrl: string,
  fallbackTitle = ""
): ReaderArticle {
  // Wrapped so a bare fragment lands in the body in every parser.
  const doc = new DOMParser().parseFromString(
    `<!doctype html><html><head></head><body>${html}</body></html>`,
    "text/html"
  )
  sanitize(doc, sourceUrl)
  const host = new URL(sourceUrl).hostname
  return {
    title: meta.title || fallbackTitle || host,
    byline: meta.byline ?? "",
    siteName: meta.site_name || host.replace(/^www\./, ""),
    content: doc.body.innerHTML,
    sourceUrl
  }
}

export function extractArticle(
  html: string,
  sourceUrl: string,
  mediaType = "text/html"
): ReaderArticle {
  const doc = parseDocument(html, mediaType)
  const base = doc.createElement("base")
  base.href = sourceUrl
  head(doc).prepend(base)

  const parsed = new Readability(doc, {
    charThreshold: 140,
    keepClasses: false
  }).parse()
  if (!parsed?.content || (parsed.textContent ?? "").trim().length < 80) {
    throw new Error("No readable article content was found")
  }

  const content = new DOMParser().parseFromString(parsed.content, "text/html")
  sanitize(content, sourceUrl)
  return {
    title: parsed.title || new URL(sourceUrl).hostname,
    byline: parsed.byline || "",
    siteName: parsed.siteName || new URL(sourceUrl).hostname.replace(/^www\./, ""),
    content: content.body.innerHTML,
    sourceUrl
  }
}

/**
 * Readability needs an HTML document: it builds its output with createElement,
 * which in an XML document would produce namespace-less elements. XHTML is
 * therefore parsed as XML — so `<div/>` and friends mean what the author wrote
 * — and the resulting tree is imported into an HTML document. Elements keep the
 * XHTML namespace either way, so the import yields real HTMLElements.
 */
function parseDocument(html: string, mediaType: string): Document {
  if (mediaType === "application/xhtml+xml") {
    const xml = new DOMParser().parseFromString(html, "application/xhtml+xml")
    const root = xml.documentElement
    if (root && !xml.querySelector("parsererror")) {
      const doc = document.implementation.createHTMLDocument("")
      doc.replaceChild(doc.importNode(root, true), doc.documentElement)
      return doc
    }
    // Ill-formed XHTML still reads fine through the forgiving HTML parser.
  }
  return new DOMParser().parseFromString(html, "text/html")
}

function head(doc: Document): HTMLHeadElement {
  if (doc.head) return doc.head
  const created = doc.createElement("head")
  doc.documentElement.prepend(created)
  return created
}

function sanitize(doc: Document, baseUrl: string): void {
  doc.querySelectorAll("script,style,noscript,template,form,iframe,object,embed,svg").forEach((node) => node.remove())
  doc.querySelectorAll<HTMLElement>("*").forEach((node) => {
    Array.from(node.attributes).forEach((attribute) => {
      if (/^on/i.test(attribute.name) || attribute.name === "style" || attribute.name === "srcset") {
        node.removeAttribute(attribute.name)
      }
    })
    for (const attribute of ["href", "src"] as const) {
      const value = node.getAttribute(attribute)
      if (!value) continue
      try {
        const resolved = new URL(value, baseUrl)
        const allowed = attribute === "href" ? ["http:", "https:", "mailto:"] : ["http:", "https:"]
        if (!allowed.includes(resolved.protocol)) throw new Error("unsafe URL")
        node.setAttribute(attribute, resolved.toString())
      } catch {
        node.removeAttribute(attribute)
      }
    }
  })
}
