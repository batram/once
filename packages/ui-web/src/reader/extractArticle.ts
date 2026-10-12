import { Readability } from "@mozilla/readability"
import { StoredContentMeta } from "@once/core"
import { sanitize, sanitizedFragmentDocument } from "./sanitizeHtml"

export interface ReaderArticle {
  mediaType?: string
  title: string
  byline: string
  siteName: string
  content: string
  sourceUrl: string
  /** A long scanned PDF read in parts: how far the reader has read. */
  pages?: { through: number; total: number }
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
  const doc = sanitizedFragmentDocument(html, sourceUrl)
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
  if (mediaType === "text/plain") {
    const doc = new DOMParser().parseFromString(html, "text/html")
    return { ...articleFromStoredContent(doc.querySelector("article")?.innerHTML ?? doc.body.innerHTML, { source: "page", saved_at: 0, title: doc.title }, sourceUrl), mediaType }
  }
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
