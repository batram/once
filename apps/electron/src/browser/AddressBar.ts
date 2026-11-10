import { ElectronPoint } from "@once/platform-electron/bridge"

interface AddressBarActions {
  /** Navigates the active tab; resolves without navigating when there is none. */
  navigate(url: string): Promise<void>
  /** Shows the native address menu; resolves with text to paste and go, or null. */
  showMenu(point: ElectronPoint): Promise<string | null>
  /** The error line changes the shell's height, so the owner re-reports bounds. */
  errorChanged(): void
}

/** The URL field of the browser shell: typing, Enter, and its context menu. */
export class AddressBar {
  private shownTab: string | null = null
  private shownUrl = ""
  /** The user has typed since the field took focus, and has not sent it. */
  private edited = false

  constructor(
    readonly input: HTMLInputElement,
    private readonly error: HTMLElement,
    private readonly actions: AddressBarActions
  ) {
    input.addEventListener("focus", () => input.select())
    input.addEventListener("input", () => {
      this.edited = true
      this.setError("")
    })
    input.addEventListener("blur", () => { this.edited = false })
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") void this.navigate(input.value)
    })
    input.addEventListener("contextmenu", (event) => {
      event.preventDefault()
      void actions.showMenu({ x: event.x, y: event.y }).then((pasted) => {
        if (!pasted) return
        input.value = pasted
        return this.navigate(pasted)
      })
    })
  }

  focus(): void {
    this.input.focus()
  }

  /**
   * Shows the active tab's address. What the user is typing stays until it is
   * sent or left, whatever the tab does meanwhile: a page that redirects, or a
   * restored one still arriving, would otherwise be what Enter opens. Only
   * another tab's address replaces it.
   */
  show(tabId: string | null, url: string): void {
    const otherTab = tabId !== this.shownTab
    const changed = otherTab || url !== this.shownUrl
    this.shownTab = tabId
    this.shownUrl = url
    if (tabId === null) return
    if (otherTab) this.edited = false
    if (this.edited) return
    if (changed || this.input.ownerDocument.activeElement !== this.input) this.input.value = url
  }

  setError(message: string): void {
    this.error.textContent = message
    this.error.classList.toggle("visible", Boolean(message))
    this.input.toggleAttribute("aria-invalid", Boolean(message))
    this.actions.errorChanged()
  }

  private async navigate(url: string): Promise<void> {
    this.input.blur()
    try {
      this.setError("")
      await this.actions.navigate(url)
    } catch (error) {
      this.setError(error instanceof Error ? error.message : String(error))
    }
  }
}
