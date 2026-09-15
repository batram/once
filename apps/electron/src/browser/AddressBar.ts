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
  constructor(
    readonly input: HTMLInputElement,
    private readonly error: HTMLElement,
    private readonly actions: AddressBarActions
  ) {
    input.addEventListener("focus", () => input.select())
    input.addEventListener("input", () => this.setError(""))
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
