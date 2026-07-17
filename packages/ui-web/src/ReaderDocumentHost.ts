export class ReaderDocumentHost {
  private readonly root: HTMLElement
  private readonly frame: HTMLIFrameElement
  private readonly runtimeUrl: string | null
  private runtimeSource: Promise<string | null> | null = null

  constructor(parent: HTMLElement = document.body, runtimeUrl: string | null = null) {
    this.runtimeUrl = runtimeUrl
    this.root = document.createElement("section")
    this.root.className = "once-reader-host"
    this.root.hidden = true
    this.root.setAttribute("aria-label", "Reader mode")

    const close = document.createElement("button")
    close.className = "once-reader-host-close"
    close.type = "button"
    close.textContent = "Back"
    close.setAttribute("aria-label", "Close reader mode")
    close.dataset.testid = "reader-close"
    close.onclick = () => this.close()

    this.frame = document.createElement("iframe")
    this.frame.className = "once-reader-host-frame"
    this.frame.title = "Reader mode"
    this.frame.setAttribute("sandbox", "allow-scripts")

    this.root.append(close, this.frame)
    parent.append(this.root)
  }

  isOpen(): boolean {
    return !this.root.hidden
  }

  isReaderWindow(source: unknown): boolean {
    return source != null && source === this.frame.contentWindow
  }

  async open(html: string): Promise<void> {
    this.frame.srcdoc = await this.injectRuntime(html)
    this.root.hidden = false
    document.body.classList.add("once-reader-open")
  }

  // Swaps the document's inline TTS script (blocked by the app CSP, which the
  // srcdoc frame inherits) for the runtime bundle. The bundle is inlined
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
    return html.replace(/<script>[\s\S]*?<\/script>/, () => scriptTag)
  }

  private loadRuntimeSource(): Promise<string | null> {
    if (!this.runtimeUrl) return Promise.resolve(null)
    this.runtimeSource ??= fetch(this.runtimeUrl)
      .then((response) => (response.ok ? response.text() : null))
      .catch(() => null)
    return this.runtimeSource
  }

  close(): void {
    this.root.hidden = true
    this.frame.removeAttribute("srcdoc")
    document.body.classList.remove("once-reader-open")
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
