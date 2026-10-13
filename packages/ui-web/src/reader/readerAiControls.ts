import { ReaderAiRequest, ReaderPages, ReaderPagesResult, ReaderRewriteResult } from "@once/core"

export type ReaderAiSend = (request: ReaderAiRequest, signal?: AbortSignal, progress?: (text: string) => void) => Promise<unknown>
/** A long scan read in parts: how far it has come, whether the model reads it, and whether it reads on to the end. */
export interface ReaderAiPaging { through: number; total: number; ai: boolean; toEnd: boolean }
/** `status` is progress while running and an error afterwards; `madeBy` names the model behind the shown rewrite. */
export interface ReaderAiState { running: boolean; canUndo: boolean; status: string; madeBy: string; pages?: ReaderAiPaging }
export type ReaderAiAction = "rewrite" | "undo" | "continue" | "finish"
/** Controls a shell draws outside the reader frame (mobile's speech bar) instead of the frame's own buttons. */
export interface ReaderAiExternalControls {
  onState(state: ReaderAiState): void
  subscribe(handler: (action: ReaderAiAction) => void): void
}
/** Pages a long scanned PDF advances by; the reader then waits to be asked for more. */
const PAGE_STEP = 5

/**
 * AI beside Original in the reader toolbar: sends the extraction (and, host-side, everything the
 * source offers) to the model and shows what it wrote. Undo returns to the state before the last rewrite.
 * A long scan read in parts gets Next and Read to end in the row under the toolbar: on-device OCR
 * until AI is used, then the model, five pages at a time.
 */
export function installReaderAi(send: ReaderAiSend, sourceUrl?: string, external?: ReaderAiExternalControls): void {
  if (document.documentElement.dataset.readerAi) return
  document.documentElement.dataset.readerAi = "true"
  const source = sourceUrl ?? document.querySelector<HTMLAnchorElement>(".reader-original")?.href ?? location.href
  if (!/^https?:\/\//.test(source)) return
  const article = document.querySelector<HTMLElement>("article") ?? document.createElement("article")
  if (!article.parentElement) document.body.append(article)
  const heading = document.querySelector<HTMLElement>("main h1")
  const documentId = document.documentElement.dataset.onceReaderSession ?? crypto.randomUUID()
  // Every rewrite starts from the reader's own extraction, never from a previous answer.
  const extraction = withoutSpeechMarkup(article), extractedTitle = heading?.textContent?.trim().slice(0, 500) ?? document.title.slice(0, 500)
  const total = readPages(document.documentElement.dataset.readerPages)?.total
  // How far the shown text reaches: on-device pages, or the model's once AI took over (undefined until then).
  let localThrough = readPages(document.documentElement.dataset.readerPages)?.through ?? 0, aiThrough: number | undefined
  let controller: AbortController | undefined, generation = 0, statusText = "", madeBy = "", toEnd = false
  // One entry per AI step, so repeated rewrites undo step by step back to the extraction.
  const history: { content: Node[]; heading: string | null; title: string; madeBy: string; localThrough: number; aiThrough?: number }[] = []
  const paging = (): ReaderAiPaging | undefined => total ? { through: aiThrough ?? localThrough, total, ai: aiThrough !== undefined, toEnd } : undefined
  const state = (): ReaderAiState => ({ running: !!controller, canUndo: history.length > 0, status: statusText, madeBy, ...(total ? { pages: paging() } : {}) })
  const update = external ? () => external.onState(state()) : toolbarControls(action => act(action), state)
  const setStatus = (text: string) => { statusText = text; update() }
  const changing = () => { document.querySelector<HTMLButtonElement>("[data-tts-stop]")?.click(); window.speechSynthesis?.cancel(); document.dispatchEvent(new Event("once-reader-content-changing")) }
  const changed = () => document.dispatchEvent(new Event("once-reader-content-changed"))
  // A copy of the nodes, not markup: Undo never sends the page back through the HTML parser.
  const snapshot = () => ({ content: Array.from(article.childNodes, node => node.cloneNode(true)), heading: heading?.textContent ?? null, title: document.title, madeBy, localThrough, aiThrough })
  function restore(): void {
    const previous = controller ? undefined : history.pop()
    if (!previous) return
    changing(); article.replaceChildren(...previous.content); if (heading) heading.textContent = previous.heading; document.title = previous.title; changed()
    madeBy = previous.madeBy; localThrough = previous.localThrough; aiThrough = previous.aiThrough; setStatus("")
  }
  /** Stops the running request, and reading on to the end with it. */
  function cancel(): void { toEnd = false; controller?.abort(); update() }
  /** Runs one request at a time and says whether it applied. */
  async function run(request: Omit<ReaderAiRequest, "id" | "documentId" | "sourceUrl">, apply: (value: unknown) => void): Promise<boolean> {
    if (controller) return false
    const current = new AbortController(), version = ++generation; controller = current
    setStatus("Sending…")
    try {
      const value = await send({ id: crypto.randomUUID(), documentId, sourceUrl: source, ...request }, current.signal, text => { if (!current.signal.aborted) setStatus(text) })
      if (version !== generation || current.signal.aborted) return false
      apply(value); statusText = ""
      return true
    } catch (error) {
      // Progress goes away when the request ends; only a failure stays to be read.
      if (version === generation) statusText = current.signal.aborted ? "" : error instanceof Error ? error.message : String(error)
      return false
    } finally { if (version === generation) { controller = undefined; update() } }
  }
  /** AI over the whole source, or over the first pages of a long scan; pressed while running, it cancels. */
  function rewrite(): Promise<boolean> {
    if (controller) { cancel(); return Promise.resolve(false) }
    const pages = total ? { from: 1, to: Math.min(PAGE_STEP, total) } : undefined
    return run({ action: "rewrite", title: extractedTitle, ...(pages ? { pages } : { html: extraction }) }, value => {
      const result = value as ReaderRewriteResult
      const template = fragment(result.html)
      const title = takeTitle(template)
      history.push(snapshot())
      changing(); article.replaceChildren(template); if (title && heading) { heading.textContent = title; document.title = title }; changed()
      madeBy = `${result.model.name} / ${result.model.model}`
      if (total) aiThrough = result.pages?.through ?? pages?.to
    })
  }
  /** The next pages of a long scan: by the model once AI took over, on the device until then. */
  async function continueReading(): Promise<boolean> {
    const through = aiThrough ?? localThrough
    if (!total || controller || through >= total) return false
    const pages = { from: through + 1, to: Math.min(through + PAGE_STEP, total) }
    if (aiThrough === undefined) {
      return run({ action: "pages", pages }, value => {
        const result = value as ReaderPagesResult
        const content = document.createDocumentFragment()
        content.append(...result.paragraphs.map(text => { const p = document.createElement("p"); p.textContent = text; return p }))
        changing(); appendPart(article, content); changed()
        localThrough = result.pages.through
      })
    }
    const previous = (article.textContent ?? "").replace(/\s+/g, " ").trim().slice(-600)
    return run({ action: "rewrite", title: heading?.textContent?.slice(0, 500) ?? extractedTitle, pages, previous }, value => {
      const result = value as ReaderRewriteResult
      const template = fragment(result.html); takeTitle(template)
      history.push(snapshot())
      changing(); appendPart(article, template); changed()
      madeBy = `${result.model.name} / ${result.model.model}`
      aiThrough = result.pages?.through ?? pages.to
    })
  }
  /** Reads part after part to the last page; Cancel or a failure stops it. Pressed again, it stops. */
  async function finish(): Promise<void> {
    if (toEnd) return cancel()
    toEnd = true; update()
    while (toEnd && await continueReading()) { /* each part shows as it arrives */ }
    toEnd = false; update()
  }
  const act = (action: ReaderAiAction) => { if (action === "undo") restore(); else if (action === "continue") void continueReading(); else if (action === "finish") void finish(); else void rewrite() }
  external?.subscribe(act)
  update()
  window.addEventListener("pagehide", () => { generation++; toEnd = false; controller?.abort() }, { once: true })
}

/**
 * The frame's own buttons just before Original, and a row under the toolbar for progress, failures
 * and, while a long scan is partly read, its page controls. Returns the redraw.
 */
function toolbarControls(act: (action: ReaderAiAction) => void, current: () => ReaderAiState): () => void {
  const group = document.createElement("div"); group.className = "reader-ai"; group.setAttribute("role", "group"); group.setAttribute("aria-label", "AI")
  const runButton = button("AI", () => act("rewrite")), back = button("Undo", () => act("undo"))
  group.append(runButton, back)
  const row = document.createElement("div"); row.className = "reader-ai-status"
  const status = document.createElement("span"); status.setAttribute("role", "status")
  const label = document.createElement("span"); label.className = "reader-ai-pages"
  const next = button("", () => act("continue")), end = button("", () => act("finish"))
  row.append(label, status, next, end)
  const toolbar = document.querySelector<HTMLElement>(".toolbar")
  const original = toolbar?.querySelector(".reader-original")
  if (original) original.before(group); else if (toolbar) toolbar.append(group); else (document.querySelector("main") ?? document.body).prepend(group)
  if (toolbar) toolbar.append(row); else group.after(row)
  return () => {
    const { running, canUndo, status: text, madeBy, pages } = current(), open = !!pages && pages.through < pages.total
    runButton.textContent = running ? "Cancel" : "AI"
    runButton.title = running ? "Stop the request" : `${madeBy ? `Rewritten by ${madeBy}. ` : ""}Rewrite with AI: sends this page's text, the image or PDF pages to your AI model`
    back.hidden = !canUndo; back.disabled = running
    status.textContent = text
    row.dataset.error = String(!running && !!text)
    label.textContent = pages ? pagesLabel(pages) : ""
    next.hidden = end.hidden = !open
    next.textContent = pages ? `Next ${Math.min(PAGE_STEP, pages.total - pages.through)}` : ""
    next.disabled = running
    end.textContent = pages?.toEnd ? "Stop" : "Read to end"
    end.disabled = running && !pages?.toEnd
    row.hidden = !text && !open
    // The row stays while pages remain, so the article starts below it.
    document.documentElement.dataset.readerStatus = String(!row.hidden)
  }
}

/** "Pages 1–5 of 29" and who read them. */
function pagesLabel(pages: ReaderAiPaging): string {
  return `Pages 1–${pages.through} of ${pages.total}${pages.ai ? " · AI" : ""}`
}

function button(label: string, action: () => void): HTMLButtonElement {
  const element = document.createElement("button"); element.type = "button"; element.textContent = label; element.onclick = action
  return element
}

/** Appends the next pages; a sentence a page break cut in two becomes one paragraph again. */
function appendPart(article: HTMLElement, content: DocumentFragment): void {
  const last = article.lastElementChild, first = content.firstElementChild
  if (last?.localName === "p" && first?.localName === "p" && !/[.!?:;"”’)\]]\s*$/.test(last.textContent ?? "") && /^\s*[\p{Ll}(,;–—-]/u.test(first.textContent ?? "")) {
    last.append(" ", ...first.childNodes)
    first.remove()
  }
  article.append(content)
}

/** The host sanitized the fragment before it reached the reader; it is parsed inert, like a template. */
function fragment(html: string): DocumentFragment {
  const content = document.createDocumentFragment()
  content.append(...new DOMParser().parseFromString(html, "text/html").body.childNodes)
  return content
}

/** A leading heading names the article; it leaves the fragment and becomes the title. */
function takeTitle(content: DocumentFragment): string | undefined {
  const first = content.firstElementChild
  if (first?.localName !== "h1") return undefined
  first.remove()
  return first.textContent?.trim() || undefined
}

function readPages(value: string | undefined): ReaderPages | undefined {
  const match = /^(\d+)\/(\d+)$/.exec(value ?? "")
  if (!match) return undefined
  const through = Number(match[1]), total = Number(match[2])
  return through >= 1 && through <= total ? { through, total } : undefined
}

/** The article as extracted: read-aloud classes and hints are presentation, not content for the model. */
function withoutSpeechMarkup(article: HTMLElement): string {
  const copy = article.cloneNode(true) as HTMLElement
  for (const element of copy.querySelectorAll<HTMLElement>("[class*='tts-']")) {
    if (element.title === "Start reading here") element.removeAttribute("title")
    element.classList.remove(...[...element.classList].filter(name => name.startsWith("tts-")))
    if (!element.classList.length) element.removeAttribute("class")
  }
  return copy.innerHTML
}
