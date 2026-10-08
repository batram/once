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
  revealStreamedContent(doc)
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

/**
 * React's streaming server rendering sends a Suspense boundary's real content
 * later in the page as `<div hidden id="S:n">`, with `<template id="B:n">`
 * holding its place where it belongs, and a script swaps the two once the
 * page runs. Fetched HTML never runs that script, so Readability sees an
 * empty placeholder and an invisible article. Doing the swap here reads the
 * page as the browser would show it.
 */
export function revealStreamedContent(doc: Document): void {
  for (const placeholder of Array.from(doc.querySelectorAll("template[id^='B:']"))) {
    const content = doc.getElementById(`S:${placeholder.id.slice(2)}`)
    if (!content || content === placeholder) continue
    content.removeAttribute("hidden")
    placeholder.replaceWith(...Array.from(content.childNodes))
    content.remove()
  }
}

function head(doc: Document): HTMLHeadElement {
  if (doc.head) return doc.head
  const created = doc.createElement("head")
  doc.documentElement.prepend(created)
  return created
}

function withoutHash(url: URL): string {
  return url.href.slice(0, url.href.length - url.hash.length)
}

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml"
const ARTICLE_TAGS = new Set([
  "a abbr address article audio b bdi bdo blockquote br",
  "caption cite code col colgroup dd del details dfn div",
  "dl dt em figcaption figure h1 h2 h3 h4 h5 h6",
  "hr i img kbd li main mark ol p picture pre",
  "q rp rt ruby s samp section small source span",
  "strong sub summary sup table tbody td tfoot th thead",
  "time tr u ul var video"
].join(" ").split(" "))
const DROP_SUBTREE = new Set([
  "base", "button", "canvas", "embed", "fencedframe", "form", "frame", "frameset",
  "head", "iframe", "input", "link", "math", "meta", "noembed", "noframes",
  "noscript", "object", "option", "plaintext", "portal", "script", "select", "style",
  "svg", "template", "textarea", "xmp"
])
const TEXT_ATTRIBUTES = new Set(["alt", "class", "dir", "id", "lang", "title"])

function sanitize(doc: Document, baseUrl: string): void {
  const base = new URL(baseUrl)
  const copyChildren = (source: Node, target: Node): void => {
    for (const child of Array.from(source.childNodes)) {
      if (child.nodeType === 3) {
        target.appendChild(doc.createTextNode(child.textContent ?? ""))
        continue
      }
      if (child.nodeType !== 1) continue
      const element = child as Element
      const tag = element.localName.toLowerCase()
      // Build a new HTML tree so unknown elements, foreign namespaces and
      // attributes cannot gain behavior when the article is parsed again.
      if (element.namespaceURI !== HTML_NAMESPACE || DROP_SUBTREE.has(tag)) continue
      if (!ARTICLE_TAGS.has(tag)) {
        copyChildren(element, target)
        continue
      }
      const safe = doc.createElement(tag)
      for (const attribute of Array.from(element.attributes)) {
        if (attribute.namespaceURI) continue
        const name = attribute.name.toLowerCase()
        const value = attribute.value
        if (TEXT_ATTRIBUTES.has(name)) {
          safe.setAttribute(name, value)
        } else if (name === "href" && tag === "a") {
          try {
            const resolved = new URL(value, base)
            if (!["http:", "https:", "mailto:"].includes(resolved.protocol)) continue
            // A jump within the article remains a fragment.
            safe.setAttribute("href", resolved.hash && withoutHash(resolved) === withoutHash(base)
              ? resolved.hash : resolved.toString())
          } catch { /* drop an invalid URL */ }
        } else if (name === "src" && ["img", "audio", "video", "source"].includes(tag)) {
          try {
            const resolved = new URL(value, base)
            if (["http:", "https:"].includes(resolved.protocol)) safe.setAttribute("src", resolved.toString())
          } catch { /* drop an invalid URL */ }
        } else if (name === "controls" && ["audio", "video"].includes(tag)) {
          safe.setAttribute("controls", "")
        } else if (name === "open" && tag === "details") {
          safe.setAttribute("open", "")
        } else if (["colspan", "rowspan", "scope"].includes(name) && ["td", "th"].includes(tag)) {
          safe.setAttribute(name, value)
        } else if (name === "start" && tag === "ol") {
          safe.setAttribute(name, value)
        } else if (name === "datetime" && tag === "time") {
          safe.setAttribute(name, value)
        }
      }
      target.appendChild(safe)
      copyChildren(element, safe)
    }
  }
  const article = doc.createDocumentFragment()
  copyChildren(doc.body, article)
  doc.body.replaceChildren(article)
}
