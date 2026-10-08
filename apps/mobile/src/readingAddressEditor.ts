import { Capacitor } from "@capacitor/core"
import { Keyboard } from "@capacitor/keyboard"
import { normalizeReadingUrl } from "@once/platform-mobile"
import { addressBarPlugin, type AddressBarPlugin } from "./addressMenu"
import {
  displayOffset,
  explodeAddress,
  isTrackingParameter,
  joinAddress,
  joinedOffset,
  lastAddressPart,
  explodeLine,
  explodeLines,
  lineIndexAt,
  removeExplodedLine,
  splitAddress,
  trackingParameters,
  withoutTrackingParameters
} from "./addressParts"

export interface AddressEditorActions {
  /** The page the editor opened on; an empty url for a blank tab. */
  page(): { url: string; title: string }
  go(url: string): void
  readerAvailable(): boolean
  readerActive(): boolean
  toggleReader(): void
}

const icon = (paths: string, size = 20): string =>
  `<svg width="${size}" height="${size}" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`

const ICONS = {
  clear: icon('<path d="M5 5l10 10M15 5L5 15"/>', 16),
  cancel: icon('<path d="M16 10H4M9 5l-5 5 5 5"/>', 16),
  undo: icon('<path d="M7 4L3 8l4 4"/><path d="M3 8h9a5 5 0 0 1 0 10H9"/>', 16),
  explode: icon('<path d="M3 4h14M6 8h11M6 12h11M6 16h11M3 8v8"/>', 16),
  collapse: icon('<path d="M3 10h14M7 6l3-3 3 3M7 14l3 3 3-3"/>', 16),
  remove: icon('<path d="M7 4h10v12H7l-5-6z"/><path d="M10 8l4 4M14 8l-4 4"/>', 16),
  trackers: icon('<path d="M4 5h12M8 5V3.5h4V5M6 5l.8 11h6.4L14 5"/>', 16),
  page: icon('<rect x="4" y="3" width="12" height="14" rx="1"/><path d="M7 7h6M7 10h6M7 13h4"/>'),
  copy: icon('<rect x="7" y="7" width="10" height="10" rx="1"/><path d="M13 4H4v9"/>'),
  share: icon('<path d="M10 3v10M6 7l4-4 4 4M4 12v5h12v-5"/>'),
  paste: icon('<rect x="5" y="4" width="10" height="13" rx="1"/><path d="M8 4V2.5h4V4"/>')
}

const TEMPLATE = `
<div class="address_editor_sheet">
  <div class="address_editor_field">
    <div class="address_editor_mirror" aria-hidden="true"></div>
    <textarea rows="1" aria-label="Address" data-testid="address-editor-input" spellcheck="false" autocapitalize="none" autocomplete="off" autocorrect="off" inputmode="url" enterkeyhint="go" placeholder="Enter a URL"></textarea>
    <button type="button" class="address_editor_clear" data-testid="address-editor-clear" aria-label="Clear address">${ICONS.clear}</button>
  </div>
  <div class="address_editor_tools" role="toolbar" aria-label="Edit address">
    <button type="button" class="address_editor_tool" data-action="cancel">${ICONS.cancel}Cancel</button>
    <button type="button" class="address_editor_tool" data-action="undo" aria-label="Undo" hidden>${ICONS.undo}</button>
    <div class="address_editor_edits">
      <button type="button" class="address_editor_tool" data-action="explode" aria-pressed="false"></button>
      <button type="button" class="address_editor_tool" data-action="remove"></button>
      <button type="button" class="address_editor_tool" data-action="trackers">${ICONS.trackers}Trackers</button>
    </div>
  </div>
  <p class="address_editor_error" role="alert" hidden></p>
</div>
<ul class="address_editor_list" aria-label="Address suggestions">
  <li class="address_editor_current" data-untouched>
    <div class="address_editor_row">${ICONS.page}<span class="address_editor_text"><b></b><span class="address_editor_url"></span></span></div>
    <button type="button" class="address_editor_icon" data-action="copy" aria-label="Copy link">${ICONS.copy}</button>
    <button type="button" class="address_editor_icon" data-action="share" aria-label="Share link">${ICONS.share}</button>
  </li>
  <li data-untouched data-reader>
    <button type="button" class="address_editor_row" data-action="reader"><span class="icon icon--chrome icon--article" aria-hidden="true"></span><span class="address_editor_text"><b></b><span>Show this page in Once's reader</span></span></button>
  </li>
  <li data-untouched data-paste>
    <button type="button" class="address_editor_row" data-action="paste">${ICONS.paste}<span class="address_editor_text"><b>Paste and go</b><span>Open the link on the clipboard</span></span></button>
  </li>
</ul>
<button type="button" class="address_editor_scrim" data-action="cancel" aria-label="Cancel editing"></button>
<div class="address_editor_toast" role="status" hidden><span></span><button type="button" class="address_editor_undo" hidden>Undo</button></div>`

/**
 * The Reading tab's address editor: a sheet over the page with the whole
 * address in one wrapped field, quick edits under it, and the current page's
 * actions below. A dialog, so the native page view steps aside for it and
 * Back closes it like any other dialog.
 */
export class ReadingAddressEditor {
  readonly dialog: HTMLDialogElement
  private readonly field: HTMLTextAreaElement
  private readonly mirror: HTMLElement
  private readonly error: HTMLElement
  private readonly toastElement: HTMLElement
  private current = ""
  private exploded = false
  private toastTimer = 0
  /** Earlier drafts, newest last; each Undo steps back one change. */
  private history: { text: string; caret: number; display?: string }[] = []
  private reported = ""
  private dismissal = 0
  private typing = false
  private typingTimer = 0

  constructor(
    private readonly anchor: HTMLElement,
    private readonly actions: AddressEditorActions,
    private readonly plugin: AddressBarPlugin | null = addressBarPlugin()
  ) {
    const dialog = document.createElement("dialog")
    dialog.id = "reading_address_editor"
    dialog.dataset.testid = "address-editor"
    dialog.setAttribute("aria-label", "Edit address")
    dialog.innerHTML = TEMPLATE
    this.dialog = dialog
    this.field = this.part<HTMLTextAreaElement>("textarea")
    this.mirror = this.part(".address_editor_mirror")
    this.error = this.part(".address_editor_error")
    this.toastElement = this.part(".address_editor_toast")
    document.body.append(dialog)
    this.bind()
  }

  get isOpen(): boolean {
    return this.dialog.open
  }

  /** Opens on the page address with the caret at `caret`, or at its end. */
  open(caret?: number): void {
    this.dismissal += 1
    const page = this.actions.page()
    this.current = page.url
    this.part(".address_editor_current b").textContent = page.title || hostOf(page.url) || page.url
    this.part(".address_editor_url").textContent = page.url.replace(/^https?:\/\//, "")
    this.part("[data-paste]").dataset.clipboard = "unknown"
    this.dialog.style.setProperty("--address-editor-top", `${this.anchor.getBoundingClientRect().top}px`)
    if (!this.dialog.open) this.dialog.showModal()
    this.history = []
    this.endTyping()
    this.setDraft(page.url, caret)
    void this.plugin?.clipboardState?.()
      .then(state => { this.part("[data-paste]").dataset.clipboard = state.hasText ? "text" : "empty"; this.render() })
      .catch(() => undefined)
  }

  close(): void {
    this.dismissal += 1
    if (this.dialog.open) this.dialog.close()
  }

  /**
   * Closes once the keyboard is down. Closing brings the native page view
   * back, and doing that while the keyboard's hide animation runs has left
   * the shell laid out for a keyboard that was gone.
   */
  private dismiss(): void {
    const dismissal = ++this.dismissal
    const typing = document.activeElement === this.field
    this.field.blur()
    if (!typing || !Capacitor.isNativePlatform()) { this.close(); return }
    void keyboardHidden(600).then(() => { if (dismissal === this.dismissal) this.close() })
  }

  clear(): void {
    this.change("", 0)
  }

  /** A change Undo can take back: the draft before it goes on the history. */
  private change(text: string, caret?: number, display?: string): void {
    this.endTyping()
    this.remember()
    this.setDraft(text, caret, display)
  }

  private remember(): void {
    const text = joinAddress(this.field.value)
    const display = this.exploded ? this.field.value : undefined
    const last = this.history.at(-1)
    if (last?.text === text && last.display === display) return
    this.history.push({ text, caret: this.caret(), display })
    if (this.history.length > 100) this.history.shift()
  }

  private undo(): void {
    this.endTyping()
    this.hideToast()
    const previous = this.history.pop()
    if (previous) this.setDraft(previous.text, previous.caret, previous.display)
  }

  /** The text menu's Explode: the selected lines split further, at "-", "." and the like. */
  private explodeSelection(): void {
    if (!this.exploded || !this.dialog.open) return
    const display = this.field.value
    const next = explodeLines(display, lineIndexAt(display, this.field.selectionStart), lineIndexAt(display, this.field.selectionEnd))
    if (next !== display) this.change(joinAddress(next), this.caret(), next)
  }

  private selectionExplodable(): boolean {
    if (!this.exploded) return false
    const display = this.field.value
    const lines = display.split("\n")
    const first = lineIndexAt(display, this.field.selectionStart)
    const last = lineIndexAt(display, this.field.selectionEnd)
    return lines.slice(first, last + 1).some(line => explodeLine(line) !== line)
  }

  /** Typing is one change until it pauses for a second or another edit comes. */
  private endTyping(): void {
    window.clearTimeout(this.typingTimer)
    this.typing = false
  }

  private bind(): void {
    const field = this.field
    field.addEventListener("beforeinput", () => {
      if (!this.typing) this.remember()
      this.typing = true
      window.clearTimeout(this.typingTimer)
      this.typingTimer = window.setTimeout(() => { this.typing = false }, 1000)
    })
    field.addEventListener("input", () => {
      if (!this.exploded && /[\r\n]/.test(field.value)) {
        const caret = joinedOffset(field.value, field.selectionStart)
        field.value = joinAddress(field.value)
        field.setSelectionRange(caret, caret)
      }
      this.error.hidden = true
      this.render()
      this.reportEditing(true)
    })
    field.addEventListener("keydown", event => {
      if (event.key !== "Enter") return
      event.preventDefault()
      this.submit(field.value)
    })
    field.addEventListener("focus", () => this.reportEditing(true))
    field.addEventListener("blur", () => this.reportEditing(false))
    // The text menu's Explode follows the selection.
    document.addEventListener("selectionchange", () => {
      if (document.activeElement === field) this.reportEditing(true)
    })
    void this.plugin?.addListener("explode", () => this.explodeSelection()).catch(() => undefined)
    this.dialog.addEventListener("close", () => {
      this.reportEditing(false)
      this.error.hidden = true
    })
    // Buttons act without taking focus, so the keyboard stays up and the
    // caret stays where it was.
    for (const button of this.dialog.querySelectorAll<HTMLButtonElement>("button")) {
      if (button.dataset.action !== "cancel") button.addEventListener("pointerdown", event => event.preventDefault())
    }
    this.part(".address_editor_clear").addEventListener("click", () => this.clear())
    this.part(".address_editor_undo").addEventListener("click", () => this.undo())
    this.bindSwipe()
    this.dialog.addEventListener("click", event => {
      const action = (event.target as HTMLElement).closest<HTMLElement>("[data-action]")?.dataset.action
      if (action) this.run(action)
    })
  }

  private run(action: string): void {
    const joined = joinAddress(this.field.value)
    if (action === "cancel") this.dismiss()
    else if (action === "undo") this.undo()
    else if (action === "explode") {
      const caret = this.caret()
      this.exploded = !this.exploded
      this.setDraft(joined, caret)
    } else if (action === "remove") {
      const part = lastAddressPart(joined)
      if (part) this.change(part.rest)
    } else if (action === "trackers") this.change(withoutTrackingParameters(joined), this.caret())
    else if (action === "copy") void this.copy()
    else if (action === "share") void this.share()
    else if (action === "paste") void this.pasteAndGo()
    else if (action === "reader") {
      this.dismiss()
      this.actions.toggleReader()
    }
  }

  /** The draft and caret in single-line terms; the field shows it split when exploded. */
  private setDraft(text: string, caret?: number, exploded?: string): void {
    // A finer split the exploded view already has is kept, not rebuilt.
    const display = this.exploded ? exploded ?? explodeAddress(text) : text
    this.field.value = display
    this.error.hidden = true
    this.render()
    this.field.focus()
    const offset = displayOffset(display, Math.min(caret ?? text.length, text.length))
    this.field.setSelectionRange(offset, offset)
  }

  private caret(): number {
    return joinedOffset(this.field.value, this.field.selectionStart)
  }

  private render(): void {
    const display = this.field.value
    const joined = joinAddress(display)
    this.mirror.innerHTML = (this.exploded ? explodedMarkup(display) : flatMarkup(display)) + "​"
    this.dialog.classList.toggle("exploded", this.exploded)
    const explode = this.button("explode")
    explode.setAttribute("aria-pressed", String(this.exploded))
    explode.innerHTML = this.exploded ? `${ICONS.collapse}Collapse` : `${ICONS.explode}Explode`
    explode.hidden = !this.exploded && joined === ""
    const part = lastAddressPart(joined)
    const remove = this.button("remove")
    remove.hidden = !part
    if (part) {
      remove.innerHTML = `${ICONS.remove}Remove <code>${escapeHtml(shorten(part.label))}</code>`
      remove.setAttribute("aria-label", `Remove ${part.label}`)
    }
    const trackers = trackingParameters(joined)
    const removeTrackers = this.button("trackers")
    removeTrackers.hidden = trackers.length === 0
    removeTrackers.setAttribute("aria-label", `Remove ${trackers.length} tracker${trackers.length === 1 ? "" : "s"}`)
    this.part(".address_editor_clear").hidden = display === ""
    this.part("[data-action=\"undo\"]").hidden = this.history.length === 0
    const untouched = this.current !== "" && joined === this.current
    for (const row of this.dialog.querySelectorAll<HTMLElement>("[data-untouched]")) row.hidden = !untouched
    const reader = this.part("[data-reader]")
    reader.hidden ||= !this.actions.readerAvailable()
    this.part("[data-reader] b").textContent = this.actions.readerActive() ? "Leave reader" : "Open in reader"
    // A blank tab offers Paste and go too; a clipboard known to be empty hides it.
    const paste = this.part("[data-paste]")
    paste.hidden = !(untouched || joined === "") || paste.dataset.clipboard === "empty"
  }

  private submit(text: string): void {
    const normalized = normalizeReadingUrl(joinAddress(text).trim())
    if (!normalized.ok) {
      this.error.textContent = normalized.error
      this.error.hidden = false
      this.field.focus()
      return
    }
    this.dismiss()
    this.actions.go(normalized.url)
  }

  private async copy(): Promise<void> {
    try {
      if (this.plugin?.copyText) await this.plugin.copyText({ text: this.current })
      else await navigator.clipboard.writeText(this.current)
      this.toast("Link copied")
    } catch {
      this.toast("The link could not be copied")
    }
  }

  private async share(): Promise<void> {
    const title = this.part(".address_editor_current b").textContent ?? ""
    try {
      if (this.plugin?.share) await this.plugin.share({ url: this.current, title })
      else if (navigator.share) await navigator.share({ url: this.current, title })
      else this.toast("Sharing is not available here")
    } catch { /* the share sheet was dismissed */ }
  }

  private async pasteAndGo(): Promise<void> {
    try {
      const text = this.plugin?.readClipboard
        ? (await this.plugin.readClipboard()).text
        : await navigator.clipboard.readText()
      if (text.trim()) this.submit(text)
      else this.toast("The clipboard is empty")
    } catch {
      this.toast("The clipboard could not be read")
    }
  }

  /** A notice; `undoable` offers Undo, which steps back the last change. */
  private toast(message: string, undoable = false): void {
    window.clearTimeout(this.toastTimer)
    this.part(".address_editor_toast > span").textContent = message
    this.part(".address_editor_undo").hidden = !undoable
    this.toastElement.hidden = false
    this.toastTimer = window.setTimeout(() => this.hideToast(), undoable ? 4000 : 1800)
  }

  private hideToast(): void {
    window.clearTimeout(this.toastTimer)
    this.toastElement.hidden = true
  }

  /**
   * In the exploded view a part's line follows a leftward swipe; let go past
   * the threshold and the part is removed, with Undo in the toast. The
   * threshold is a share of the room left of the finger: a short part like
   * "/blog" sits near the edge, and a fixed distance could run off the screen
   * before it is reached. A mostly vertical drag is left to scrolling, a tap
   * to the caret.
   */
  private bindSwipe(): void {
    let swipe: { line: HTMLElement; index: number; x: number; y: number; dx: number; active: boolean; threshold: number } | null = null
    const threshold = (x: number) => Math.max(24, Math.min(64, x * 0.4))
    const reset = () => {
      if (swipe) { swipe.line.style.left = ""; swipe.line.classList.remove("removing") }
      swipe = null
    }
    this.field.addEventListener("touchstart", (event) => {
      reset()
      const touch = event.touches[0]
      if (!this.exploded || event.touches.length !== 1 || !touch) return
      const hit = this.lineAt(touch.clientY)
      if (hit) swipe = { ...hit, x: touch.clientX, y: touch.clientY, dx: 0, active: false, threshold: threshold(touch.clientX) }
    }, { passive: true })
    this.field.addEventListener("touchmove", (event) => {
      const touch = event.touches[0]
      if (!swipe || !touch) return
      const dx = touch.clientX - swipe.x
      const dy = touch.clientY - swipe.y
      if (!swipe.active) {
        if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { reset(); return }
        if (dx > -6 || Math.abs(dx) < Math.abs(dy)) return
        swipe.active = true
      }
      event.preventDefault()
      swipe.dx = Math.min(0, dx)
      swipe.line.style.left = `${swipe.dx}px`
      swipe.line.classList.toggle("removing", -swipe.dx > swipe.threshold)
    }, { passive: false })
    this.field.addEventListener("touchend", (event) => {
      if (!swipe?.active) { swipe = null; return }
      event.preventDefault()
      const remove = -swipe.dx > swipe.threshold ? swipe.index : -1
      reset()
      if (remove >= 0) this.removeLine(remove)
    }, { passive: false })
    this.field.addEventListener("touchcancel", reset)
  }

  /** The exploded line drawn at viewport height `y`. */
  private lineAt(y: number): { line: HTMLElement; index: number } | null {
    for (const line of this.mirror.querySelectorAll<HTMLElement>("[data-line]")) {
      for (const rect of line.getClientRects()) {
        if (y >= rect.top - 6 && y <= rect.bottom + 6) return { line, index: Number(line.dataset.line) }
      }
    }
    return null
  }

  private removeLine(index: number): void {
    const display = this.field.value
    const removed = display.split("\n")[index] ?? ""
    const start = index === 0 ? 0 : display.split("\n").slice(0, index).join("\n").length + 1
    const next = removeExplodedLine(display, index)
    this.change(joinAddress(next), joinedOffset(display, start), next)
    this.toast(`Removed ${shorten(removed, 24)}`, true)
  }

  /**
   * Lets the native text menu offer "Paste and go" and "Clear" in this field
   * too, and "Explode" while the selection is on a line that splits further.
   */
  private reportEditing(editing: boolean): void {
    const state = {
      editing: editing && this.dialog.open,
      hasText: this.field.value !== "",
      explodable: editing && this.dialog.open && this.selectionExplodable()
    }
    const key = JSON.stringify(state)
    if (key === this.reported) return
    this.reported = key
    void this.plugin?.setEditing(state).catch(() => undefined)
  }

  private button(action: string): HTMLButtonElement {
    return this.part<HTMLButtonElement>(`.address_editor_edits [data-action="${action}"]`)
  }

  private part<T extends HTMLElement = HTMLElement>(selector: string): T {
    const element = this.dialog.querySelector<T>(selector)
    if (!element) throw new Error(`Missing address editor part: ${selector}`)
    return element
  }
}

/**
 * A finger tap on the address opens the editor with the caret under the
 * finger. Keyboard focus and scripted input still edit the field in place.
 */
export function openEditorOnTap(address: HTMLInputElement, editor: ReadingAddressEditor): void {
  let start: { x: number; y: number } | null = null
  address.addEventListener("touchstart", (event) => {
    const touch = event.touches[0]
    start = touch ? { x: touch.clientX, y: touch.clientY } : null
    event.preventDefault()
  }, { passive: false })
  address.addEventListener("touchend", (event) => {
    const touch = event.changedTouches[0]
    event.preventDefault()
    if (!touch || !start || Math.abs(touch.clientX - start.x) > 12 || Math.abs(touch.clientY - start.y) > 12) return
    address.blur()
    editor.open(offsetAtPoint(address, touch.clientX))
  }, { passive: false })
}

/** The caret offset in `input`'s value under a tap at `clientX`. */
export function offsetAtPoint(input: HTMLInputElement, clientX: number): number {
  const style = getComputedStyle(input)
  const context = document.createElement("canvas").getContext("2d")
  const value = input.value
  if (!context) return value.length
  context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
  const x = clientX - input.getBoundingClientRect().left - parseFloat(style.paddingLeft) -
    parseFloat(style.borderLeftWidth) + input.scrollLeft
  let previous = 0
  for (let index = 1; index <= value.length; index += 1) {
    const width = context.measureText(value.slice(0, index)).width
    if (width >= x) return x - previous < width - x ? index - 1 : index
    previous = width
  }
  return value.length
}

/** Resolves when the keyboard reports it is hidden, or after `timeout` ms. */
function keyboardHidden(timeout: number): Promise<void> {
  return new Promise(resolve => {
    let settled = false
    let handle: { remove(): Promise<void> } | null = null
    const done = () => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      void handle?.remove().catch(() => undefined)
      resolve()
    }
    const timer = window.setTimeout(done, timeout)
    Keyboard.addListener("keyboardDidHide", done)
      .then(registered => { handle = registered; if (settled) void registered.remove().catch(() => undefined) })
      .catch(done)
    void Keyboard.hide().catch(() => undefined)
  })
}

function hostOf(url: string): string {
  try { return new URL(url).host } catch { return "" }
}

function shorten(text: string, length = 12): string {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[character] ?? character)
}

function flatMarkup(text: string): string {
  const parts = splitAddress(text)
  return `<span class="dim">${escapeHtml(parts.scheme)}</span><span class="site">${escapeHtml(parts.host)}</span>` +
    `${escapeHtml(parts.path)}<span class="dim">${escapeHtml(parts.query + parts.hash)}</span>`
}

/** Each line in its own span, so a swipe can find and move it. */
function explodedMarkup(text: string): string {
  return text.split("\n").map((line, index) =>
    `<span class="address_editor_line" data-line="${index}">${explodedLine(line, index)}</span>`
  ).join("\n")
}

function explodedLine(line: string, index: number): string {
  if (index === 0 && /^[a-z][a-z0-9+.-]*:\/\/$/i.test(line)) return `<span class="dim">${escapeHtml(line)}</span>`
  if (index <= 1 && !/^[/?&#]/.test(line)) {
    const host = line.replace(/\/$/, "")
    return `<span class="site">${escapeHtml(host)}</span>${escapeHtml(line.slice(host.length))}`
  }
  if (line.startsWith("?") || line.startsWith("&")) {
    const tracker = isTrackingParameter(line.slice(1).split("=")[0] ?? "")
    return `<span class="${tracker ? "tracker" : "dim"}">${escapeHtml(line)}</span>`
  }
  if (line.startsWith("#")) return `<span class="dim">${escapeHtml(line)}</span>`
  return escapeHtml(line)
}
