export class ReaderDocumentHost {
  private readonly root: HTMLElement
  private readonly frame: HTMLIFrameElement
  private readonly scriptUrl: string | null

  constructor(parent: HTMLElement = document.body, scriptUrl: string | null = null) {
    this.scriptUrl = scriptUrl
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

  async open(html: string): Promise<void> {
    this.frame.srcdoc = this.scriptUrl
      ? html.replace(
        /<script>[\s\S]*?<\/script>/,
        `<script src="${escapeHtmlAttribute(this.scriptUrl)}"></script>`
      )
      : html
    this.root.hidden = false
    document.body.classList.add("once-reader-open")
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
