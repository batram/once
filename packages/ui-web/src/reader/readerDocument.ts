import { ReaderArticle } from "./extractArticle"
import { installReaderTts } from "./readerTts"

export type ReaderTheme = "system" | "light" | "dark"

export function readerDocument(article: ReaderArticle, theme: ReaderTheme = "system"): string {
  return `<!doctype html><html data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${escapeHtml(article.title)}</title><style>${readerStyles}</style></head><body><header class="toolbar"><div class="tts-controls" role="group" aria-label="Text to speech"><button class="tts-button" type="button" data-tts-back disabled title="Previous segment" aria-label="Previous segment">&#8592;</button><button class="tts-button tts-play" type="button" data-tts-play>Speak</button><button class="tts-button" type="button" data-tts-forward disabled title="Next segment" aria-label="Next segment">&#8594;</button><button class="tts-button" type="button" data-tts-stop disabled title="Stop" aria-label="Stop">&#9632;</button><label class="tts-speed">Speed <input data-tts-rate type="range" min="0.5" max="6" step="0.1" value="1"><output data-tts-rate-value>1.0×</output></label><details class="tts-settings"><summary>Voice</summary><div class="tts-settings-menu"><label for="tts-voice-select">Speaker</label><select id="tts-voice-select" data-tts-voice><option>Default voice</option></select></div></details></div><a href="${escapeHtml(article.sourceUrl)}">Original</a></header><main><p class="site">${escapeHtml(article.siteName)}</p><h1>${escapeHtml(article.title)}</h1>${article.byline ? `<p class="byline">${escapeHtml(article.byline)}</p>` : ""}<article>${article.content}</article><script>(${installReaderTts.toString()})();</script></main></body></html>`
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
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin: 0 -20px;
  padding: 6px 12px;
  background: var(--reader-bg);
  border-bottom: 1px solid var(--reader-border);
}

.toolbar a {
  padding: 4px 10px;
  font: 600 13px system-ui;
}

.tts-controls {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font: 600 12px/1.3 system-ui, sans-serif;
}

.tts-button,
.tts-settings summary,
.tts-settings-menu select {
  box-sizing: border-box;
  min-height: 26px;
  color: var(--reader-text);
  background: var(--reader-bg);
  border: 1px solid #000;
  border-radius: 2px;
}

.tts-button {
  min-width: 28px;
  padding: 3px 9px;
  cursor: pointer;
}

.tts-play {
  min-width: 62px;
}

.tts-button:hover:not(:disabled),
.tts-settings summary:hover {
  background: rgb(107 107 239 / 20%);
}

.tts-button:disabled {
  cursor: default;
  opacity: 0.5;
}

.tts-speed {
  display: flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
}

.tts-speed input {
  width: 90px;
}

.tts-speed output {
  min-width: 2.5em;
  font-variant-numeric: tabular-nums;
}

.tts-settings {
  position: relative;
}

.tts-settings summary {
  display: flex;
  align-items: center;
  padding: 3px 9px;
  cursor: pointer;
  list-style: none;
  user-select: none;
}

.tts-settings summary::-webkit-details-marker {
  display: none;
}

.tts-settings summary::after {
  margin-left: 5px;
  content: "▾";
}

.tts-settings[open] summary::after {
  content: "▴";
}

.tts-settings-menu {
  position: absolute;
  top: calc(100% + 5px);
  left: 0;
  z-index: 5;
  box-sizing: border-box;
  width: min(320px, 80vw);
  padding: 10px;
  color: var(--reader-text);
  background: var(--reader-bg);
  border: 1px solid var(--reader-border);
  box-shadow: 0 4px 14px rgb(0 0 0 / 24%);
}

.tts-settings-menu label {
  display: block;
  margin-bottom: 5px;
}

.tts-settings-menu select {
  width: 100%;
}

.tts-segment {
  border-radius: 2px;
  transition: background-color 160ms ease-out, box-shadow 160ms ease-out;
}

.tts-segment:hover {
  cursor: pointer;
  background: rgb(107 107 239 / 10%);
}

.tts-segment.tts-current {
  background: rgb(107 107 239 / 24%);
  box-shadow: 0 0 0 2px rgb(107 107 239 / 12%);
}

@media (max-width: 700px) {
  .toolbar {
    align-items: stretch;
    flex-direction: column-reverse;
  }

  .toolbar > a {
    align-self: flex-end;
  }

  .tts-controls {
    flex-wrap: wrap;
  }

  .tts-speed {
    flex: 1 1 180px;
  }
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
