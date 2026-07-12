import { Readability } from "@mozilla/readability"

export interface ReaderArticle {
  title: string
  byline: string
  siteName: string
  content: string
  sourceUrl: string
}

export function extractArticle(html: string, sourceUrl: string): ReaderArticle {
  const doc = new DOMParser().parseFromString(html, "text/html")
  const base = doc.createElement("base")
  base.href = sourceUrl
  doc.head.prepend(base)

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
