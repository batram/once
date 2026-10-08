import type { SentTabView } from "@once/app"
import { humanTime, summarizeTabState, SyncedTab } from "@once/core"
import { hostOf } from "./devicePresentation"
import { fillLine } from "./stateLine"

/** How long a touch must rest on a row before its menu opens. */
const LONG_PRESS_MS = 500
const MOVE_TOLERANCE_PX = 10

/** What a row does when chosen or asked for more. */
export interface RowActions {
  open(background: boolean): void
  /** The row's ⋯ button, a right click or a long press. */
  more?(anchor: HTMLElement): void
  /** Sent tabs only: takes it out of the list here. */
  dismiss?(): void
}

/** A time as the lists say it: "just now", "5 mins ago". */
export function ago(time: string): string {
  const text = humanTime(Date.parse(time))
  return text === "seconds ago" ? "just now" : text
}

/** Screenshots already shown, by id: a row made again shows its picture at once. */
export class ThumbnailCache {
  private readonly known = new Map<string, string>()
  private readonly pending = new Map<string, Promise<string | null>>()

  constructor(private readonly fetch?: (id: string) => Promise<string | null>) {}

  /** Puts the screenshot into `frame`, now when known, else once it arrives. */
  show(frame: HTMLElement, id: string): void {
    const known = this.known.get(id)
    if (known) { place(frame, known); return }
    if (!this.fetch) return
    let request = this.pending.get(id)
    if (!request) {
      request = this.fetch(id).catch(() => null)
      this.pending.set(id, request)
    }
    void request.then((src) => {
      this.pending.delete(id)
      if (!src) return
      this.known.set(id, src)
      // The row may show another page by now.
      if (frame.dataset.thumb === id) place(frame, src)
    })
  }
}

/** The screenshot replaces the site's initial only once it has decoded, so nothing blinks. */
function place(frame: HTMLElement, src: string): void {
  const reference = frame.dataset.thumb
  const current = frame.querySelector("img")
  if (current?.getAttribute("src") === src) return
  const image = document.createElement("img")
  image.alt = ""
  image.src = src
  const swap = () => {
    if (frame.dataset.thumb !== reference) return
    frame.replaceChildren(image)
    // A phone's shot also fills the frame behind itself, blurred.
    frame.style.setProperty("--shot", `url("${src}")`)
  }
  if (image.complete || typeof image.decode !== "function") swap()
  else void image.decode().then(swap, () => undefined)
}

/**
 * A tab row, made once per tab and updated in place afterwards: the link
 * (thumbnail, title, details) and the ⋯ button for everything else.
 */
export function tabRow(): HTMLLIElement {
  const row = document.createElement("li")
  row.className = "remote_tab"
  row.dataset.testid = "remote-tab"
  const link = document.createElement("a")
  link.className = "remote_tab_link"
  const frame = document.createElement("span")
  frame.className = "remote_tab_preview"
  frame.setAttribute("aria-hidden", "true")
  const text = document.createElement("span")
  text.className = "remote_tab_text"
  const title = document.createElement("span")
  title.className = "remote_tab_title"
  const detail = document.createElement("span")
  detail.className = "remote_tabs_meta"
  text.append(title, detail)
  link.append(frame, text)
  row.append(link)
  return row
}

/** Fills a tab row for `tab`; unchanged text and pictures are left alone. */
export function updateTabRow(row: HTMLLIElement, tab: SyncedTab, actions: RowActions, thumbs: ThumbnailCache): void {
  const link = row.querySelector<HTMLAnchorElement>(".remote_tab_link")
  const frame = row.querySelector<HTMLElement>(".remote_tab_preview")
  if (!link || !frame) return
  setText(row.querySelector(".remote_tab_title"), tab.title || tab.url)
  fillLine(row.querySelector(".remote_tabs_meta"), [
    hostOf(tab.url),
    tab.mode === "reader" && "Reader",
    summarizeTabState(tab.state),
    ago(tab.activityAt)
  ])
  if (link.getAttribute("href") !== tab.url) link.href = tab.url
  link.title = tab.url
  showPreview(frame, tab.url, tab.thumb?.id, thumbs)
  // A phone's capture is tall: the frame shows it whole rather than cropped.
  if (tab.thumb && tab.thumb.h > tab.thumb.w) frame.dataset.portrait = "true"
  else delete frame.dataset.portrait
  bindRow(row, link, tab.title || tab.url, actions)
}

/** A tab another device sent here: the same row, with who sent it and a × to dismiss. */
export function updateSentRow(row: HTMLLIElement, sent: SentTabView, actions: RowActions, thumbs: ThumbnailCache): void {
  const link = row.querySelector<HTMLAnchorElement>(".remote_tab_link")
  const frame = row.querySelector<HTMLElement>(".remote_tab_preview")
  if (!link || !frame) return
  row.dataset.testid = "remote-sent-tab"
  setText(row.querySelector(".remote_tab_title"), sent.title || sent.url)
  fillLine(row.querySelector(".remote_tabs_meta"), [`from ${sent.fromName}`, hostOf(sent.url),
    summarizeTabState(sent.state), ago(sent.createdAt)])
  if (link.getAttribute("href") !== sent.url) link.href = sent.url
  link.title = sent.url
  showPreview(frame, sent.url, undefined, thumbs)
  bindRow(row, link, sent.title || sent.url, actions)
}

function showPreview(frame: HTMLElement, url: string, thumb: string | undefined, thumbs: ThumbnailCache): void {
  if (thumb) frame.dataset.shot = "true"
  else delete frame.dataset.shot
  if (frame.dataset.thumb === (thumb ?? "") && frame.childElementCount) {
    // Still the initial: the picture may have arrived since.
    if (thumb && !frame.querySelector("img")) thumbs.show(frame, thumb)
    return
  }
  frame.dataset.thumb = thumb ?? ""
  const host = hostOf(url)
  // Each site keeps one of a few tints, so its rows are told apart before they are read.
  frame.dataset.tone = String([...host].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 4)
  const initial = document.createElement("span")
  initial.textContent = host.charAt(0).toUpperCase()
  frame.replaceChildren(initial)
  frame.style.removeProperty("--shot")
  if (thumb) thumbs.show(frame, thumb)
}

function setText(element: Element | null, text: string): void {
  if (element && element.textContent !== text) element.textContent = text
}

const bound = new WeakMap<HTMLLIElement, RowActions>()

/**
 * The row's controls call whatever actions it holds now, so updating a row
 * swaps its actions rather than stacking listeners.
 */
function bindRow(row: HTMLLIElement, link: HTMLAnchorElement, name: string, actions: RowActions): void {
  const first = !bound.has(row)
  bound.set(row, actions)
  trailingButton(row, "remote_tab_more", actions.more ? `More for ${name}` : null, "more", "remote-tab-more",
    (button) => bound.get(row)?.more?.(button))
  trailingButton(row, "remote_tab_dismiss", actions.dismiss ? `Dismiss ${name}` : null, "x", "remote-tab-dismiss",
    () => bound.get(row)?.dismiss?.())
  if (!first) return
  // A link, so it can be focused, copied and middle-clicked like one; the
  // shell decides where it opens.
  link.addEventListener("click", (event) => {
    event.preventDefault()
    if (row.dataset.pressed === "menu") return
    bound.get(row)?.open(Boolean(event.metaKey || event.ctrlKey || event.shiftKey))
  })
  link.addEventListener("auxclick", (event) => {
    if (event.button !== 1) return
    event.preventDefault()
    bound.get(row)?.open(true)
  })
  row.addEventListener("contextmenu", (event) => {
    const more = bound.get(row)?.more
    if (!more) return
    event.preventDefault()
    more(row.querySelector<HTMLElement>(".remote_tab_more") ?? row)
  })
  attachLongPress(row, () => {
    const more = bound.get(row)?.more
    if (more) more(row.querySelector<HTMLElement>(".remote_tab_more") ?? row)
  })
}

function trailingButton(row: HTMLElement, className: string, label: string | null, icon: string, testid: string,
  run: (button: HTMLButtonElement) => void): void {
  let button = row.querySelector<HTMLButtonElement>(`.${className}`)
  if (!label) { button?.remove(); return }
  if (!button) {
    button = document.createElement("button")
    button.type = "button"
    button.className = `button button--icon remote_tab_action ${className}`
    button.dataset.testid = testid
    const glyph = document.createElement("span")
    glyph.className = `icon icon--chrome icon--${icon}`
    glyph.setAttribute("aria-hidden", "true")
    button.append(glyph)
    const target = button
    button.addEventListener("click", () => run(target))
    row.append(button)
  }
  button.setAttribute("aria-label", label)
  button.title = label
}

/**
 * A touch held still on the row opens its menu, as on the story list; the
 * click the finger's lift then makes is not an open.
 */
function attachLongPress(row: HTMLLIElement, open: () => void): void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let start = { x: 0, y: 0 }
  const cancel = () => { clearTimeout(timer); timer = undefined }
  row.addEventListener("pointerdown", (event) => {
    if (event.pointerType !== "touch" || !event.isPrimary) return
    delete row.dataset.pressed
    start = { x: event.clientX, y: event.clientY }
    cancel()
    timer = setTimeout(() => {
      timer = undefined
      row.dataset.pressed = "menu"
      open()
      // The lift's click lands on the link; it is dropped once, then forgotten.
      setTimeout(() => { delete row.dataset.pressed }, 600)
    }, LONG_PRESS_MS)
  })
  row.addEventListener("pointermove", (event) => {
    if (timer && Math.hypot(event.clientX - start.x, event.clientY - start.y) > MOVE_TOLERANCE_PX) cancel()
  })
  row.addEventListener("pointerup", cancel)
  row.addEventListener("pointercancel", cancel)
}
