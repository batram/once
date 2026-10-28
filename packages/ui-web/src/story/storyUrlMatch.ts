import type { StoryListItem } from "./StoryListItem"

/**
 * A local search that matches a row's URL shows that URL in full on a line
 * under the title, with the matching parts marked: the title line only shows
 * the hostname, so otherwise nothing tells why the row matched.
 */

export interface UrlMatchPart {
  text: string
  match: boolean
}

/** `url` cut into runs, every case-insensitive occurrence of `needle` marked; null when there is none. */
export function urlMatchParts(url: string, needle: string): UrlMatchPart[] | null {
  if (needle === "") return null
  const haystack = url.toLowerCase()
  const lowered = needle.toLowerCase()
  const parts: UrlMatchPart[] = []
  let from = 0
  let at = haystack.indexOf(lowered)
  if (at === -1) return null
  while (at !== -1) {
    if (at > from) parts.push({ text: url.slice(from, at), match: false })
    parts.push({ text: url.slice(at, at + needle.length), match: true })
    from = at + needle.length
    at = haystack.indexOf(lowered, from)
  }
  if (from < url.length) parts.push({ text: url.slice(from), match: false })
  return parts
}

/** The story's own URL first, then where the redirect rules send it. */
function matchingUrl(row: StoryListItem, needle: string): [string, UrlMatchPart[]] | null {
  const urls = [row.story.href, row.dataset.redirected_url]
  for (const url of urls) {
    if (!url) continue
    const parts = urlMatchParts(url, needle)
    if (parts) return [url, parts]
  }
  return null
}

// The last needle a search showed, so a row redrawn mid-search keeps its line.
let current_needle = ""

/** Adds, replaces or removes the row's URL line for `needle` ("" removes it). */
export function showUrlMatch(row: StoryListItem, needle = current_needle): void {
  current_needle = needle
  const existing = row.querySelector<HTMLElement>(":scope > .data > .search_url")
  const found = matchingUrl(row, needle)
  if (!found) {
    existing?.remove()
    return
  }
  const [url, parts] = found
  const line = document.createElement("div")
  line.classList.add("search_url")
  line.dataset.testid = "story-search-url"
  line.title = url
  for (const part of parts) {
    if (part.match) {
      const mark = document.createElement("mark")
      mark.textContent = part.text
      line.appendChild(mark)
    } else {
      line.appendChild(document.createTextNode(part.text))
    }
  }
  if (existing) {
    existing.replaceWith(line)
  } else {
    row.title_line.after(line)
  }
}
