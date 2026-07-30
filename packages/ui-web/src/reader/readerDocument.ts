import { ReaderArticle } from "./extractArticle"
import { createStandaloneReaderTtsScript } from "./readerTts"
import readerTemplate from "./readerDocument.html?raw"
import styles from "./readerDocument.css?raw"

export type ReaderTheme = "system" | "light" | "dark"
export const readerStyles = styles

export function readerDocument(
  article: ReaderArticle,
  theme: ReaderTheme = "system"
): string {
  const values: Record<string, string> = {
    ARTICLE: article.content,
    BYLINE: article.byline
      ? `<p class="byline">${escapeHtml(article.byline)}</p>`
      : "",
    SITE_NAME: escapeHtml(article.siteName),
    SOURCE_URL: escapeHtml(article.sourceUrl),
    STYLES: readerStyles,
    THEME: theme,
    TITLE: escapeHtml(article.title),
    TTS_SCRIPT: createStandaloneReaderTtsScript()
  }
  return readerTemplate.replace(
    /\{\{([A-Z_]+)\}\}/g,
    (_placeholder, key: string) => values[key] ?? ""
  )
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[character] ?? character
  )
}
