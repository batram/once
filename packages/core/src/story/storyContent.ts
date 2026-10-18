// What counts as an article when a feed offers text: a teaser of one or two
// sentences is not worth storing, since the reader would show less than the
// page does. Counted on the text, not the markup, so a paragraph of tags does
// not pass on its own.

export const MIN_FEED_CONTENT_CHARS = 300

/** The visible text of an html fragment, roughly: tags and entities removed. */
export function textOfHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/** WordPress request nonces are hidden transport metadata, not saved article content. */
export function normalizeFeedContent(html: string): string {
  return html.replace(/<input\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi, tag => {
    const attributes = new Map<string, string>()
    const pattern = /(?:^|\s)([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g
    for (const match of tag.slice(6, -1).matchAll(pattern)) {
      attributes.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4] ?? "")
    }
    return attributes.get("type")?.toLowerCase() === "hidden" && attributes.get("name") === "_wpnonce" ? "" : tag
  })
}

export function feedContentIsArticle(html: string): boolean {
  return textOfHtml(html).length >= MIN_FEED_CONTENT_CHARS
}
