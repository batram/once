import {
  classifyReaderLink,
  isReaderLinkRequest,
  isReaderMenuRequest,
  READER_LINK_CHANNEL,
  READER_LINK_VERSION,
  readerLinkRequest,
  type ReaderMenuRequest
} from "./readerLinkProtocol"

/** Frame half: no link tap ever navigates the reader frame itself. */
export function installReaderLinks(target: Window): void {
  const doc = target.document
  doc.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0) return
    const anchor = (event.target as Element | null)?.closest?.("a[href], area[href]")
    if (!anchor) return
    event.preventDefault()
    const action = classifyReaderLink(anchor.getAttribute("href"))
    if (action.kind === "fragment") {
      const destination = doc.getElementById(action.id) ?? doc.getElementsByName(action.id)[0]
      if (destination) destination.scrollIntoView({ block: "start" })
      else if (action.id === "" || action.id.toLowerCase() === "top") target.scrollTo(0, 0)
    } else if (action.kind === "open") {
      target.parent.postMessage(readerLinkRequest(action.url), "*")
    }
  })
}

/**
 * Frame half of the long-press menu: names the link and image pressed. Only
 * web links and loaded images go out; anything else keeps the default.
 */
export function installReaderLinkMenu(target: Window): void {
  // WebKit draws its own link menu on iOS; this one must never suppress it.
  if (!/Android/i.test(target.navigator.userAgent)) return
  target.document.addEventListener("contextmenu", (event) => {
    const element = event.target as Element | null
    const anchor = element?.closest?.("a[href], area[href]")
    const action = anchor ? classifyReaderLink(anchor.getAttribute("href")) : null
    const link = action?.kind === "open" && /^https?:/.test(action.url) ? action.url : undefined
    const image = element?.closest?.("img") as HTMLImageElement | null | undefined
    const src = image ? image.currentSrc || image.src : ""
    const imageUrl = /^(https?|data):/.test(src) ? src : undefined
    if (!link && !imageUrl) return
    event.preventDefault()
    const request: ReaderMenuRequest = {
      channel: READER_LINK_CHANNEL,
      version: READER_LINK_VERSION,
      type: "menu",
      link,
      linkText: link ? anchor?.textContent?.trim() || undefined : undefined,
      image: imageUrl
    }
    target.parent.postMessage(request, "*")
  })
}

/** Host half of the long-press menu. */
export function installReaderLinkMenuHost(
  isReaderWindow: (source: MessageEventSource | null) => boolean,
  show: (request: ReaderMenuRequest) => void,
  host: Pick<Window, "addEventListener"> = window
): void {
  host.addEventListener("message", (event) => {
    if (!isReaderMenuRequest(event.data) || !isReaderWindow(event.source)) return
    const text = (value: unknown): string | undefined => typeof value === "string" && value ? value : undefined
    show({ ...event.data, link: text(event.data.link), linkText: text(event.data.linkText), image: text(event.data.image) })
  })
}

/** Host half: opens what the reader frame hands over. */
export function installReaderLinkHost(
  isReaderWindow: (source: MessageEventSource | null) => boolean,
  open: (url: string) => void,
  host: Pick<Window, "addEventListener"> = window
): void {
  host.addEventListener("message", (event) => {
    if (!isReaderLinkRequest(event.data) || !isReaderWindow(event.source)) return
    const action = classifyReaderLink(event.data.url)
    if (action.kind === "open") open(action.url)
  })
}
