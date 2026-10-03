import {
  classifyReaderLink,
  isReaderLinkRequest,
  readerLinkRequest
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
