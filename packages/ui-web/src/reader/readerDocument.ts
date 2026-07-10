import { ReaderArticle } from "./extractArticle"

export type ReaderTheme = "system" | "light" | "dark"

export function readerDocument(article: ReaderArticle, theme: ReaderTheme = "system"): string {
  return `<!doctype html><html data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${escapeHtml(article.title)}</title><style>${readerStyles}</style></head><body><header class="toolbar"><a href="${escapeHtml(article.sourceUrl)}">Original</a></header><main><p class="site">${escapeHtml(article.siteName)}</p><h1>${escapeHtml(article.title)}</h1>${article.byline ? `<p class="byline">${escapeHtml(article.byline)}</p>` : ""}<article>${article.content}</article></main></body></html>`
}

export const readerStyles = `
:root {
  color-scheme: light dark;
  --reader-bg: rgb(246, 246, 239);
  --reader-text: #202020;
  --reader-border: #aaa;
}

html[data-theme="light"] {
  color-scheme: light;
}

html[data-theme="dark"] {
  color-scheme: dark;
  --reader-bg: #282a36;
  --reader-text: #bcc2cd;
  --reader-border: #555;
}

@media (prefers-color-scheme: dark) {
  html[data-theme="system"] {
    --reader-bg: #282a36;
    --reader-text: #bcc2cd;
    --reader-border: #555;
  }
}

html {
  margin: 0;
  padding: 0;
  display: flex;
  box-sizing: content-box;
  width: 100%;
  color: var(--reader-text);
  background: var(--reader-bg);
}

body {
  margin: auto;
  padding: 0 20px;
  max-width: 700px;
  font-family: Georgia, "Times New Roman", Times, serif;
  font-size: 1.1em;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
  box-sizing: border-box;
  width: 100%;
  display: flex;
  flex-direction: column;
}

a {
  color: #6b6bef;
}

h1 {
  margin: 5px 0;
  font-size: 25px;
}

img,
pre,
p {
  max-width: 100%;
  width: auto;
  height: auto;
}

iframe {
  min-width: 600px;
  min-height: 340px;
}

img {
  max-width: 100%;
  max-height: 350px;
}

pre {
  background: rgb(216 216 216 / 40%);
  font-size: 0.8em;
  overflow-x: auto;
  padding: 10px;
}

ul {
  margin: 5px;
  padding: 0 25px;
}

.toolbar {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  justify-content: flex-end;
  margin: 0 -20px;
  padding: 6px 12px;
  background: var(--reader-bg);
  border-bottom: 1px solid var(--reader-border);
}

.toolbar a {
  padding: 4px 10px;
  font: 600 13px system-ui;
}

.once-reader-error {
  position: relative;
  z-index: 2147483647;
  box-sizing: border-box;
  width: min(100%, 700px);
  margin: 12px auto;
  padding: 12px 16px;
  color: white;
  background: #9b2c2c;
  border: 1px solid #641d1d;
  border-radius: 2px;
  font: 600 14px/1.4 system-ui, sans-serif;
}
`

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]))
}
