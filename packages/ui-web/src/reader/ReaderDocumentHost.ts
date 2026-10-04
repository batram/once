export class ReaderDocumentHost {
  private readonly root: HTMLElement
  private readonly frame: HTMLIFrameElement
  private readonly runtimeUrl: string | null
  private documentVersion = 0
  private scrollPosition: () => number = () => 0
  private runtimeSource: Promise<string | null> | null = null

  constructor(private readonly parent: HTMLElement = document.body, runtimeUrl: string | null = null) {
    this.runtimeUrl = runtimeUrl
    this.root = document.createElement("section")
    this.root.className = "once-reader-host"
    this.root.hidden = true
    this.root.setAttribute("aria-label", "Reader mode")

    const close = document.createElement("button")
    close.className = "button once-reader-host-close"
    close.type = "button"
    close.textContent = "Back"
    close.setAttribute("aria-label", "Close reader mode")
    close.dataset.testid = "reader-frame-close"
    close.onclick = () => this.close()

    this.frame = document.createElement("iframe")
    this.frame.className = "once-reader-host-frame"
    this.frame.title = "Reader mode"
    this.frame.setAttribute("sandbox", "allow-scripts")

    this.frame.addEventListener("load", () => {
      this.frame.contentWindow?.postMessage({ channel: "once-reader-scroll", type: "restore", y: this.scrollPosition() }, "*")
    })
    this.root.append(close, this.frame)
    parent.append(this.root)
  }

  /** Read at each document load, so a later document restores the latest position. */
  setScrollPosition(position: () => number): void { this.scrollPosition = position }

  createSibling(): ReaderDocumentHost {
    return new ReaderDocumentHost(this.parent, this.runtimeUrl)
  }

  setVisible(visible: boolean): void {
    this.root.hidden = !visible || !this.frame.hasAttribute("srcdoc")
    document.body.classList.toggle("once-reader-open", Boolean(document.querySelector(".once-reader-host:not([hidden])")))
  }

  destroy(): void {
    this.close()
    this.root.remove()
  }

  isOpen(): boolean {
    return !this.root.hidden
  }

  isReaderWindow(source: unknown): boolean {
    return source != null && source === this.frame.contentWindow
  }

  /** Posts into the reader document; nothing happens while none is open. */
  post(message: unknown): void {
    if (this.root.hidden) return
    this.frame.contentWindow?.postMessage(message, "*")
  }

  async open(html: string): Promise<void> {
    const version = ++this.documentVersion
    const document = await this.injectRuntime(html)
    if (version !== this.documentVersion) return
    // Mirrors the document theme onto the frame element so its backdrop
    // (exposed by iOS rubber-band overscroll) matches the reader background.
    this.frame.dataset.theme = /<html[^>]*\sdata-theme="([a-z]+)"/i.exec(html)?.[1] ?? "system"
    this.frame.srcdoc = document
    this.root.hidden = false
    globalThis.document.body.classList.add("once-reader-open")
  }

  // Swaps the document's inert runtime marker for the platform bundle. The
  // bundle is inlined
  // because older WebKit (iOS <=18) refuses to load external scripts inside
  // the opaque-origin sandboxed frame; the app CSP whitelists exactly this
  // inline text via its sha256 hash (ReaderRuntimeCspPlugin), so the escaping
  // here must stay identical to the build-time hash computation. A src script
  // is the fallback when the bundle text cannot be fetched.
  private async injectRuntime(html: string): Promise<string> {
    if (!this.runtimeUrl) return html
    const source = await this.loadRuntimeSource()
    const scriptTag = source != null
      ? `<script>${source.replace(/<\/script/gi, "<\\/script")}</script>`
      : `<script src="${escapeHtmlAttribute(this.runtimeUrl)}"></script>`
    return html.replace(
      /<script data-once-reader-runtime><\/script>/,
      () => scriptTag
    )
  }

  private loadRuntimeSource(): Promise<string | null> {
    if (!this.runtimeUrl) return Promise.resolve(null)
    this.runtimeSource ??= fetch(this.runtimeUrl)
      .then((response) => (response.ok ? response.text() : null))
      .catch(() => null)
    return this.runtimeSource
  }

  close(): void {
    this.documentVersion += 1
    this.root.hidden = true
    this.frame.removeAttribute("srcdoc")
    document.body.classList.toggle("once-reader-open", Boolean(document.querySelector(".once-reader-host:not([hidden])")))
  }
}

function escapeHtmlAttribute(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character] ?? character)
}
