// The allowlist that untrusted HTML passes through before Once shows it: an
// extracted article, a feed's text, a comment from an aggregator.

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

/** Rebuilds `doc.body` from allowed elements and attributes only. */
export function sanitize(doc: Document, baseUrl: string): void {
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

/** Parses an HTML fragment into a detached, sanitized document. */
export function sanitizedFragmentDocument(html: string, baseUrl: string): Document {
  // Wrapped so a bare fragment lands in the body in every parser.
  const doc = new DOMParser().parseFromString(
    `<!doctype html><html><head></head><body>${html}</body></html>`,
    "text/html"
  )
  sanitize(doc, baseUrl)
  return doc
}
