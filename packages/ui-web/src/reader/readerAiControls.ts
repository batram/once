import { AiProvenance, AiResolvedModel, ReaderAiRequest, ReaderFormatResult, readFormatEdits } from "@once/core"
import { captureFormatBlocks } from "./readerFormatting"

export type ReaderAiSend = (request: ReaderAiRequest, signal?: AbortSignal, progress?: (text: string) => void) => Promise<unknown>
export function installReaderAi(send: ReaderAiSend, sourceUrl?: string): void {
  if (document.querySelector("[data-reader-ai]")) return
  const source = sourceUrl ?? document.querySelector<HTMLAnchorElement>(".reader-original")?.href ?? location.href
  if (!/^https?:\/\//.test(source)) return
  const article = document.querySelector<HTMLElement>("article") ?? document.createElement("article")
  if (!article.parentElement) document.body.append(article)
  const documentId = document.documentElement.dataset.onceReaderSession ?? crypto.randomUUID()
  const original = article.innerHTML
  const group = document.createElement("section"); group.dataset.readerAi = "true"; group.className = "reader-ai"; group.setAttribute("aria-label", "Reader AI assistance")
  const details = document.createElement("details")
  const summary = document.createElement("summary"); summary.textContent = "AI assistance"
  const status = document.createElement("p"); status.setAttribute("role", "status")
  const disclosure = document.createElement("p"); disclosure.textContent = "These actions send content to the model shown below. Results stay in this session until saved."
  let controller: AbortController | undefined, generation = 0
  let provenance: AiProvenance | undefined
  const models: Partial<Record<"format" | "ocr", AiResolvedModel>> = {}
  const request = (action: ReaderAiRequest["action"], extra: Partial<ReaderAiRequest> = {}, signal?: AbortSignal) => send({ id: crypto.randomUUID(), documentId, action, sourceUrl: source, ...extra }, signal, text => { if (!signal?.aborted) status.textContent = text })
  const button = (label: string, action: () => void) => { const element = document.createElement("button"); element.type = "button"; element.textContent = label; element.onclick = action; return element }
  const changing = () => { document.querySelector<HTMLButtonElement>("[data-tts-stop]")?.click(); window.speechSynthesis?.cancel(); document.dispatchEvent(new Event("once-reader-content-changing")) }
  const changed = () => document.dispatchEvent(new Event("once-reader-content-changed"))
  const format = button("Improve formatting", () => void run("format"))
  const ocr = button("Read with AI", () => void run("ocr"))
  const isDocument = document.documentElement.dataset.readerKind === "document" || /\.(pdf|png|jpe?g|webp)(?:[?#]|$)/i.test(source) || !article.textContent?.trim() || !!article.querySelector("[data-reader-error]")
  ocr.hidden = !isDocument
  const formattingAvailable = () => captureFormatBlocks(article).blocks.length > 0 && !article.querySelector("[data-reader-error]")
  const cancel = button("Cancel", () => controller?.abort())
  const restore = button("Restore original", () => { generation++; controller?.abort(); controller = undefined; changing(); article.innerHTML = original; changed(); provenance = undefined; status.textContent = "Original restored"; update() })
  const save = button("Save generated content", () => void (async () => {
    save.disabled = true
    try { await request("save", { html: article.innerHTML, title: document.querySelector("h1")?.textContent?.slice(0, 500) ?? document.title, provenance }); status.textContent = "Generated content saved" }
    catch (error) { status.textContent = error instanceof Error ? error.message : String(error) }
    finally { save.disabled = false }
  })())
  const actions = document.createElement("div"); actions.className = "reader-ai-actions"; actions.append(format, ocr, cancel, restore, save)
  const modelNames = document.createElement("p")
  const update = () => { format.disabled = !!controller || !models.format || !formattingAvailable(); ocr.disabled = !!controller || !models.ocr; cancel.hidden = !controller; restore.hidden = !provenance; save.hidden = !provenance; save.disabled = !!controller }
  details.append(summary, disclosure, modelNames, status, actions); group.append(details)
  const main = document.querySelector("main"); if (main) main.before(group); else document.body.prepend(group)
  details.addEventListener("toggle", () => {
    if (!details.open || controller) return
    void Promise.all((isDocument ? ["format", "ocr"] as const : ["format"] as const).map(async action => {
      try { models[action] = await request("resolve", { consumer: action === "format" ? "reader.formatting" : "reader.ocr" }) as AiResolvedModel }
      catch (error) { status.textContent = error instanceof Error ? error.message : String(error) }
    })).then(() => {
      modelNames.textContent = Object.entries(models).map(([action, model]) => `${action === "format" ? "Formatting" : "OCR"}: ${model.name} / ${model.model}`).join(" · ")
      update()
    })
  })
  async function run(action: "format" | "ocr"): Promise<void> {
    const model = models[action]
    if (controller || !model) return
    const current = new AbortController(), version = ++generation; controller = current; update()
    status.textContent = `Sending to ${model.name} / ${model.model}…`
    try {
      const sourceBlocks = action === "format" ? captureFormatBlocks(article) : undefined
      const result = await request(action, { model, ...(sourceBlocks ? { blocks: sourceBlocks.blocks } : {}) }, current.signal)
      current.signal.throwIfAborted()
      if (version !== generation) return
      if (sourceBlocks) {
        const formatted = result as ReaderFormatResult
        const edits = readFormatEdits(JSON.stringify(formatted.blocks), sourceBlocks.blocks)
        changing(); sourceBlocks.apply(edits); changed()
        provenance = { operation: "formatting", connection: formatted.model.connection, provider: formatted.model.provider, model: formatted.model.model, generatedAt: formatted.generatedAt }
      } else {
        const recognized = result as { paragraphs: string[]; ai?: AiProvenance }
        if (!Array.isArray(recognized.paragraphs) || !recognized.paragraphs.length || recognized.paragraphs.some(text => typeof text !== "string")) throw new Error("AI returned no readable text")
        const paragraphs = recognized.paragraphs.map(text => { const p = document.createElement("p"); p.textContent = text; return p })
        changing(); article.replaceChildren(...paragraphs); changed(); provenance = recognized.ai
      }
      status.textContent = provenance ? "AI result ready. Review before saving." : "Embedded document text restored."
    } catch (error) { if (version === generation) status.textContent = current.signal.aborted ? "Cancelled; document retained" : error instanceof Error ? error.message : String(error) }
    finally { if (version === generation) { controller = undefined; update() } }
  }
  update()
  window.addEventListener("pagehide", () => { generation++; controller?.abort() }, { once: true })
}
