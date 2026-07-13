const HIDE_DELAY = 800

export class HoverUrlIndicator {
  private static instance: HoverUrlIndicator | null = null
  private readonly element: HTMLElement
  private readonly text: HTMLElement
  private hoveredAnchor: HTMLAnchorElement | null = null
  private hideTimeout: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly root: HTMLElement) {
    this.element = document.createElement("div")
    this.element.id = "hover_url"
    this.element.setAttribute("aria-hidden", "true")

    this.text = document.createElement("span")
    this.text.id = "hover_url_text"
    this.element.append(this.text)
    this.root.append(this.element)

    document.addEventListener("mouseover", this.handleMouseOver)
    document.addEventListener("mouseout", this.handleMouseOut)
  }

  static mount(): HoverUrlIndicator | null {
    const root = document.querySelector<HTMLElement>("#stories_panel")
    this.instance = root ? new HoverUrlIndicator(root) : null
    return this.instance
  }

  static show(url: string): void {
    this.instance?.setUrl(url)
  }

  destroy(): void {
    this.clearHideTimeout()
    document.removeEventListener("mouseover", this.handleMouseOver)
    document.removeEventListener("mouseout", this.handleMouseOut)
    this.element.remove()
    if (HoverUrlIndicator.instance === this) HoverUrlIndicator.instance = null
  }

  private readonly handleMouseOver = (event: MouseEvent): void => {
    const target = event.target
    if (!(target instanceof Element)) return

    const anchor = target.closest<HTMLAnchorElement>("a[href]")
    if (!anchor || !this.root.contains(anchor) || anchor === this.hoveredAnchor) {
      return
    }

    this.hoveredAnchor = anchor
    const url = anchor.href || anchor.getAttribute("href") || ""
    this.setUrl(url)
  }

  private readonly handleMouseOut = (event: MouseEvent): void => {
    if (!this.hoveredAnchor) return

    const relatedTarget = event.relatedTarget
    if (
      relatedTarget instanceof Node &&
      this.hoveredAnchor.contains(relatedTarget)
    ) {
      return
    }

    const target = event.target
    if (!(target instanceof Node) || !this.hoveredAnchor.contains(target)) {
      return
    }

    this.hoveredAnchor = null
    this.setUrl("")
  }

  private setUrl(url: string): void {
    this.clearHideTimeout()
    if (url) {
      this.text.textContent = url
      this.element.title = url
      this.element.classList.add("visible")
      return
    }

    this.hideTimeout = setTimeout(() => {
      this.element.classList.remove("visible")
      this.hideTimeout = null
    }, HIDE_DELAY)
  }

  private clearHideTimeout(): void {
    if (!this.hideTimeout) return
    clearTimeout(this.hideTimeout)
    this.hideTimeout = null
  }
}
