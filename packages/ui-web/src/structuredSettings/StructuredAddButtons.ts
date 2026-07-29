import { AnchoredMenuItem } from "../StoryAnchoredMenu"
import { StructuredSettingsSection } from "./searchNavigation"

type Section = StructuredSettingsSection

export interface StructuredAddButtonHost {
  mode(section: Section): "list" | "text"
  isDetail(section: Section): boolean
  editSource(root: HTMLElement): void
  editGroup(root: HTMLElement): void
  editFilter(root: HTMLElement): void
  editRedirect(root: HTMLElement): void
  openMenu(anchor: HTMLElement, items: AnchoredMenuItem[]): void
}

export class StructuredAddButtons {
  private buttons = new Map<Section, HTMLButtonElement>()

  constructor(private host: StructuredAddButtonHost) {}

  install(section: Section, block: HTMLElement, root: HTMLElement): void {
    const labels: Record<Section, string> = {
      sources: "Add source",
      filters: "Add filter",
      redirects: "Add redirect"
    }
    const testids: Record<Section, string> = {
      sources: "add-source",
      filters: "add-filter",
      redirects: "add-redirect"
    }
    const button = document.createElement("button")
    button.type = "button"
    button.className = "structured_add_button"
    button.dataset.testid = testids[section]
    button.title = labels[section]
    button.setAttribute("aria-label", labels[section])
    const glyph = document.createElement("span")
    glyph.className = "structured_add_glyph"
    glyph.setAttribute("aria-hidden", "true")
    glyph.textContent = "+"
    button.append(glyph)
    button.addEventListener("click", () => this.activate(section, root, button))
    ;(block.closest<HTMLElement>(".settings_section") || block).append(button)
    this.buttons.set(section, button)
  }

  update(section: Section): void {
    const button = this.buttons.get(section)
    if (button) {
      button.hidden = this.host.mode(section) !== "list" ||
        this.host.isDetail(section)
    }
  }

  private activate(
    section: Section,
    root: HTMLElement,
    button: HTMLButtonElement
  ): void {
    if (section === "filters") return this.host.editFilter(root)
    if (section === "redirects") return this.host.editRedirect(root)
    this.host.openMenu(button, this.sourceMenu(root))
  }

  private sourceMenu(root: HTMLElement): AnchoredMenuItem[] {
    const items: AnchoredMenuItem[] = [
      {
        id: "add-source-entry",
        label: "Source",
        testid: "add-source-entry",
        select: () => this.host.editSource(root)
      },
      {
        id: "add-group",
        label: "Group",
        testid: "add-group",
        select: () => this.host.editGroup(root)
      }
    ]
    const picker = document.querySelector<HTMLElement>("#pick_source_button")
    if (picker && !picker.hidden) {
      items.push({
        id: "pick-source-page",
        label: "Pick from page",
        testid: "pick-source-page",
        select: () => picker.click()
      })
    }
    return items
  }
}
