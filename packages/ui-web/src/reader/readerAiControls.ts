import { ReaderAiRequest, ReaderRewriteResult } from "@once/core"

export type ReaderAiSend = (request: ReaderAiRequest, signal?: AbortSignal, progress?: (text: string) => void) => Promise<unknown>
/** `status` is progress while running and an error afterwards; `madeBy` names the model behind the shown rewrite. */
export interface ReaderAiState { running: boolean; canUndo: boolean; status: string; madeBy: string }
/** Controls a shell draws outside the reader frame (mobile's speech bar) instead of the frame's own buttons. */
export interface ReaderAiExternalControls {
  onState(state: ReaderAiState): void
  subscribe(handler: (action: "rewrite" | "undo") => void): void
}

/**
 * AI beside Original in the reader toolbar: sends the extraction (and, host-side, everything the
 * source offers) to the model and shows what it wrote. Undo returns to the state before the last rewrite.
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
  let controller: AbortController | undefined, generation = 0, statusText = "", madeBy = ""
  // One entry per rewrite, so repeated rewrites undo step by step back to the extraction.
  const history: { html: string; heading: string | null; title: string; madeBy: string }[] = []
  const update = external ? () => external.onState({ running: !!controller, canUndo: history.length > 0, status: statusText, madeBy }) : toolbarControls(() => void rewrite(), restore)
  const setStatus = (text: string) => { statusText = text; update() }
  const changing = () => { document.querySelector<HTMLButtonElement>("[data-tts-stop]")?.click(); window.speechSynthesis?.cancel(); document.dispatchEvent(new Event("once-reader-content-changing")) }
  const changed = () => document.dispatchEvent(new Event("once-reader-content-changed"))
  function restore(): void {
    const previous = controller ? undefined : history.pop()
    if (!previous) return
    changing(); article.innerHTML = previous.html; if (heading) heading.textContent = previous.heading; document.title = previous.title; changed()
    madeBy = previous.madeBy; setStatus("")
  }
  async function rewrite(): Promise<void> {
    if (controller) { controller.abort(); return }
    const current = new AbortController(), version = ++generation; controller = current
    setStatus("Sending…")
    try {
      const result = await send({ id: crypto.randomUUID(), documentId, action: "rewrite", sourceUrl: source, html: extraction, title: extractedTitle }, current.signal,
        text => { if (!current.signal.aborted) setStatus(text) }) as ReaderRewriteResult
      if (version !== generation || current.signal.aborted) return
      // The host sanitized the fragment; a leading heading names the article.
      const template = document.createElement("template"); template.innerHTML = result.html
      const first = template.content.firstElementChild
      const title = first?.localName === "h1" ? first.textContent?.trim() : undefined
      if (title) first?.remove()
      history.push({ html: article.innerHTML, heading: heading?.textContent ?? null, title: document.title, madeBy })
      changing(); article.replaceChildren(template.content); if (title && heading) { heading.textContent = title; document.title = title }; changed()
      statusText = ""; madeBy = `${result.model.name} / ${result.model.model}`
    } catch (error) {
      // Progress goes away when the request ends; only a failure stays to be read.
      if (version === generation) statusText = current.signal.aborted ? "" : error instanceof Error ? error.message : String(error)
    } finally { if (version === generation) { controller = undefined; update() } }
  }
  external?.subscribe(action => { if (action === "undo") restore(); else void rewrite() })
  update()
  window.addEventListener("pagehide", () => { generation++; controller?.abort() }, { once: true })

  /** The frame's own buttons just before Original, with status on a row of its own; returns the redraw. */
  function toolbarControls(onRun: () => void, onUndo: () => void): () => void {
    const group = document.createElement("div"); group.className = "reader-ai"; group.setAttribute("role", "group"); group.setAttribute("aria-label", "AI")
    const button = (label: string, action: () => void) => { const element = document.createElement("button"); element.type = "button"; element.textContent = label; element.onclick = action; return element }
    const run = button("AI", onRun), back = button("Undo", onUndo)
    group.append(run, back)
    const status = document.createElement("p"); status.className = "reader-ai-status"; status.setAttribute("role", "status")
    const toolbar = document.querySelector<HTMLElement>(".toolbar")
    const original = toolbar?.querySelector(".reader-original")
    if (original) original.before(group); else if (toolbar) toolbar.append(group); else (document.querySelector("main") ?? document.body).prepend(group)
    if (toolbar) toolbar.append(status); else group.after(status)
    return () => {
      run.textContent = controller ? "Cancel" : "AI"
      run.title = controller ? "Stop the AI request" : `${madeBy ? `Rewritten by ${madeBy}. ` : ""}Rewrite with AI: sends this page's text, the image or PDF pages to your AI model`
      back.hidden = !history.length; back.disabled = !!controller
      status.textContent = statusText
      status.dataset.error = String(!controller && !!statusText)
    }
  }
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
