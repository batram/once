import { normalizeReadingUrl } from "@once/platform-mobile"
import { addressBarPlugin, type AddressBarPlugin } from "./addressMenu"
import {
  displayOffset,
  explodeAddress,
  isTrackingParameter,
  joinAddress,
  joinedOffset,
  lastAddressPart,
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
<p class="address_editor_toast" role="status" hidden></p>`

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
    const page = this.actions.page()
    this.current = page.url
    this.part(".address_editor_current b").textContent = page.title || hostOf(page.url) || page.url
    this.part(".address_editor_url").textContent = page.url.replace(/^https?:\/\//, "")
    this.part("[data-paste]").dataset.clipboard = "unknown"
    this.dialog.style.setProperty("--address-editor-top", `${this.anchor.getBoundingClientRect().top}px`)
    if (!this.dialog.open) this.dialog.showModal()
    this.setDraft(page.url, caret)
    void this.plugin?.clipboardState?.()
      .then(state => { this.part("[data-paste]").dataset.clipboard = state.hasText ? "text" : "empty"; this.render() })
      .catch(() => undefined)
  }

  close(): void {
    if (this.dialog.open) this.dialog.close()
  }

  clear(): void {
    this.setDraft("", 0)
  }

  private bind(): void {
    const field = this.field
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
    this.dialog.addEventListener("click", event => {
      const action = (event.target as HTMLElement).closest<HTMLElement>("[data-action]")?.dataset.action
      if (action) this.run(action)
    })
  }

  private run(action: string): void {
    const joined = joinAddress(this.field.value)
    if (action === "cancel") this.close()
    else if (action === "explode") {
      const caret = this.caret()
      this.exploded = !this.exploded
      this.setDraft(joined, caret)
    } else if (action === "remove") {
      const part = lastAddressPart(joined)
      if (part) this.setDraft(part.rest)
    } else if (action === "trackers") this.setDraft(withoutTrackingParameters(joined), this.caret())
    else if (action === "copy") void this.copy()
    else if (action === "share") void this.share()
    else if (action === "paste") void this.pasteAndGo()
    else if (action === "reader") {
      this.close()
      this.actions.toggleReader()
    }
  }

  /** The draft and caret in single-line terms; the field shows it split when exploded. */
  private setDraft(text: string, caret?: number): void {
    const display = this.exploded ? explodeAddress(text) : text
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
    this.close()
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

  private toast(message: string): void {
    window.clearTimeout(this.toastTimer)
    this.toastElement.textContent = message
    this.toastElement.hidden = false
    this.toastTimer = window.setTimeout(() => { this.toastElement.hidden = true }, 1800)
  }

  /** Lets the native text menu offer "Paste and go" and "Clear" in this field too. */
  private reportEditing(editing: boolean): void {
    void this.plugin?.setEditing({ editing: editing && this.dialog.open, hasText: this.field.value !== "" })
      .catch(() => undefined)
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

function explodedMarkup(text: string): string {
  return text.split("\n").map((line, index) => {
    if (index === 0) {
      const match = /^([a-z][a-z0-9+.-]*:\/\/)?(.*)$/i.exec(line)
      const rest = match?.[2] ?? line
      const host = rest.replace(/\/$/, "")
      return `<span class="dim">${escapeHtml(match?.[1] ?? "")}</span><span class="site">${escapeHtml(host)}</span>${escapeHtml(rest.slice(host.length))}`
    }
    if (line.startsWith("?") || line.startsWith("&")) {
      const tracker = isTrackingParameter(line.slice(1).split("=")[0] ?? "")
      return `<span class="${tracker ? "tracker" : "dim"}">${escapeHtml(line)}</span>`
    }
    if (line.startsWith("#")) return `<span class="dim">${escapeHtml(line)}</span>`
    return escapeHtml(line)
  }).join("\n")
}
