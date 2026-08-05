import {
  GenySelectorConf,
  parse as genyParse,
  sanitize_selector_conf
} from "@once/collectors/geny"
import {
  cssSegment,
  generalizeStorySelector,
  relativeFieldSelector,
  safeQueryAll
} from "./selectorPolicy"
import {
  buildPickerConf,
  parsePickerConf,
  serializePickerConf
} from "./sourceLinePolicy"
import { OVERLAY_STYLES } from "./overlayStyles"

export { cssSegment, generalizeStorySelector, relativeFieldSelector }

// In-page overlay that lets the user build a geny_match selector
// configuration by clicking elements (like an adblocker element picker) or
// editing CSS selectors, with a live preview of the parsed stories. Runs
// inside the target page: injected by the Electron main process into browser
// tabs and by the extension background as a content script.

export interface SourcePickResult {
  conf: string
  url: string
}

type FieldKey = "stories" | "link" | "title" | "timestamp" | "tag"

interface FieldSpec {
  key: FieldKey
  label: string
  optional: boolean
  hint: string
}

const FIELDS: FieldSpec[] = [
  { key: "stories", label: "Stories", optional: false, hint: "repeated story element" },
  { key: "link", label: "Link", optional: false, hint: "link inside a story" },
  { key: "title", label: "Title", optional: false, hint: "title inside a story" },
  { key: "timestamp", label: "Time", optional: true, hint: "optional time element" },
  { key: "tag", label: "Tag", optional: true, hint: "optional tag or author" }
]

const MAX_HIGHLIGHTS = 150
const PREVIEW_LIMIT = 8

class PickerOverlay {
  private readonly host: HTMLElement
  private readonly shadow: ShadowRoot
  private readonly boxes: HTMLElement
  private readonly catcher: HTMLElement
  private readonly hoverHint: HTMLElement
  private readonly status: HTMLElement
  private readonly preview: HTMLElement
  private readonly sourceInput: HTMLTextAreaElement
  private readonly saveButton: HTMLButtonElement
  private readonly inputs = new Map<FieldKey, HTMLInputElement>()
  private readonly counts = new Map<FieldKey, HTMLElement>()
  private readonly pickButtons = new Map<FieldKey, HTMLButtonElement>()
  private readonly components = new Map<FieldKey, string>()
  private picking: FieldKey | null = null
  private focusField: FieldKey = "stories"
  private hoverTarget: Element | null = null
  // Extras from a hand-edited source line (comment_href, additional tags,
  // custom processors) survive as long as their form fields stay untouched.
  private baseConf: GenySelectorConf = {}
  private updateTimer: number | null = null
  private sourceTimer: number | null = null
  private frame: number | null = null
  private finish: ((result: SourcePickResult | null) => void) | null = null

  private readonly onScroll = (): void => this.scheduleRender()
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && this.picking) {
      event.preventDefault()
      event.stopPropagation()
      this.setPicking(null)
    }
  }
  private readonly onPageHide = (): void => this.resolve(null)

  constructor() {
    this.host = document.createElement("once-source-picker")
    this.shadow = this.host.attachShadow({ mode: "open" })

    const style = document.createElement("style")
    style.textContent = OVERLAY_STYLES
    this.shadow.append(style)

    this.boxes = this.el("div", { id: "boxes" })
    this.catcher = this.el("div", { id: "catcher" })
    this.hoverHint = this.el("div", { id: "hoverhint" })

    const panel = this.el("div", { id: "panel" })
    panel.append(this.el("h1", { text: "Pick a story source" }))
    for (const field of FIELDS) panel.append(this.buildRow(field))
    const source = this.el("div", { id: "source" })
    source.append(this.el("label", { text: "Source line" }))
    this.sourceInput = document.createElement("textarea")
    this.sourceInput.spellcheck = false
    this.sourceInput.rows = 3
    this.sourceInput.oninput = () => this.scheduleSourceApply()
    source.append(this.sourceInput)
    this.status = this.el("div", { id: "status" })
    this.preview = this.el("div", { id: "preview" })
    const actions = this.el("div", { id: "actions" })
    const cancel = this.el("button", { text: "Cancel" }) as HTMLButtonElement
    cancel.onclick = () => this.resolve(null)
    this.saveButton = this.el("button", { text: "Save source" }) as HTMLButtonElement
    this.saveButton.className = "save"
    this.saveButton.disabled = true
    this.saveButton.onclick = () => this.save()
    actions.append(cancel, this.saveButton)
    panel.append(source, this.status, this.preview, actions)

    this.shadow.append(this.boxes, this.catcher, this.hoverHint, panel)
    this.bindCatcher()
  }

  run(): Promise<SourcePickResult | null> {
    return new Promise((resolve) => {
      this.finish = resolve
      document.documentElement.append(this.host)
      window.addEventListener("scroll", this.onScroll, { capture: true, passive: true })
      window.addEventListener("resize", this.onScroll)
      window.addEventListener("keydown", this.onKeyDown, true)
      window.addEventListener("pagehide", this.onPageHide)
      this.setStatus("Pick the repeated story element, then its link and title.")
      this.setPicking("stories")
      this.update()
    })
  }

  private el(
    tag: string,
    options: { id?: string; text?: string } = {}
  ): HTMLElement {
    const element = document.createElement(tag)
    if (options.id) element.id = options.id
    if (options.text) element.textContent = options.text
    return element
  }

  private buildRow(field: FieldSpec): HTMLElement {
    const row = this.el("div")
    row.className = "row"
    const label = this.el("label", { text: field.label })
    const input = this.el("input") as HTMLInputElement
    input.type = "text"
    input.spellcheck = false
    input.placeholder = field.optional ? `${field.hint} (optional)` : field.hint
    input.oninput = () => {
      this.focusField = field.key
      this.scheduleUpdate()
    }
    input.onfocus = () => {
      this.focusField = field.key
      this.scheduleRender()
    }
    const count = this.el("span", { text: "–" })
    count.className = "count"
    const pick = this.el("button", { text: "Pick" }) as HTMLButtonElement
    pick.onclick = () => {
      this.setPicking(this.picking === field.key ? null : field.key)
    }
    this.inputs.set(field.key, input)
    this.counts.set(field.key, count)
    this.pickButtons.set(field.key, pick)
    row.append(label, input, count, pick)
    return row
  }

  private bindCatcher(): void {
    this.catcher.addEventListener("mousemove", (event) => {
      this.hoverTarget = this.elementAt(event.clientX, event.clientY)
      this.moveHoverHint(event.clientX, event.clientY)
      this.scheduleRender()
    })
    this.catcher.addEventListener("mouseleave", () => {
      this.hoverTarget = null
      this.hoverHint.hidden = true
      this.scheduleRender()
    })
    for (const type of ["mousedown", "mouseup", "contextmenu"]) {
      this.catcher.addEventListener(type, (event) => event.preventDefault())
    }
    this.catcher.addEventListener("click", (event) => {
      event.preventDefault()
      event.stopPropagation()
      const target = this.elementAt(event.clientX, event.clientY)
      if (target) this.pickElement(target)
    })
  }

  private elementAt(x: number, y: number): Element | null {
    for (const candidate of document.elementsFromPoint(x, y)) {
      if (candidate !== this.host && !this.host.contains(candidate)) {
        return candidate
      }
    }
    return null
  }

  private moveHoverHint(x: number, y: number): void {
    if (!this.picking || !this.hoverTarget) {
      this.hoverHint.hidden = true
      return
    }
    this.hoverHint.textContent = this.hoverSelector(this.hoverTarget)
    this.hoverHint.hidden = false
    this.hoverHint.style.left = `${Math.min(x + 14, window.innerWidth - 220)}px`
    this.hoverHint.style.top = `${Math.min(y + 18, window.innerHeight - 30)}px`
  }

  private hoverSelector(target: Element): string {
    if (this.picking === "stories") {
      const selector = generalizeStorySelector(target)
      return `${selector} (${safeQueryAll(document.body, selector).length})`
    }
    return cssSegment(target)
  }

  private setPicking(field: FieldKey | null): void {
    this.picking = field
    if (field) this.focusField = field
    this.hoverTarget = null
    this.hoverHint.hidden = true
    this.catcher.hidden = !field
    for (const [key, button] of this.pickButtons) {
      button.classList.toggle("picking", key === field)
      button.textContent = key === field ? "Esc" : "Pick"
    }
    if (field && field !== "stories" && !this.value("stories")) {
      this.setStatus("Pick the story element first so fields can be matched inside it.")
    }
    this.scheduleRender()
  }

  private pickElement(target: Element): void {
    if (!this.picking) return
    const field = this.picking
    if (field === "stories") {
      this.setValue("stories", generalizeStorySelector(target))
      this.setStatus("Now pick the link inside one of the highlighted stories.")
      this.setPicking(this.value("link") ? null : "link")
    } else {
      const story = this.storyElements().find(
        (candidate) => candidate === target || candidate.contains(target)
      )
      if (!story) {
        this.setStatus("Click inside one of the highlighted story elements.")
        return
      }
      const resolved = this.resolveFieldTarget(field, story, target)
      if (!resolved) {
        this.setStatus("Pick an element inside the story, not the story itself.")
        return
      }
      this.setValue(field, resolved.selector)
      this.components.set(field, resolved.component)
      if (field === "link" && !this.value("title")) {
        this.setStatus("Now pick the title inside a story.")
        this.setPicking("title")
      } else {
        this.setPicking(null)
      }
    }
    this.update()
  }

  private resolveFieldTarget(
    field: FieldKey,
    story: Element,
    target: Element
  ): { selector: string; component: string } | null {
    let element: Element = target
    let component = "innerText"
    if (field === "link") {
      const anchor = target.closest("a[href]")
      if (anchor && story.contains(anchor)) element = anchor
      component = "href"
    } else if (field === "timestamp") {
      const time = target.closest("time[datetime]")
      if (time && story.contains(time)) {
        element = time
        component = "dateTime"
      }
    }
    const selector = relativeFieldSelector(story, element)
    if (!selector) return null
    return { selector, component }
  }

  private value(field: FieldKey): string {
    return this.inputs.get(field)?.value.trim() || ""
  }

  private setValue(field: FieldKey, selector: string): void {
    const input = this.inputs.get(field)
    if (input) input.value = selector
  }

  private storyElements(): Element[] {
    return safeQueryAll(document.body, this.value("stories"))
  }

  private buildConf(): GenySelectorConf | null {
    if (!this.value("stories") || !this.value("link") || !this.value("title")) {
      return null
    }
    return this.buildLooseConf()
  }

  // Combines the form fields with the extras of a hand-edited source line;
  // a field only regenerates its selector slot when its selector changed, so
  // custom components and processors survive round trips through the fields.
  private buildLooseConf(): GenySelectorConf {
    return buildPickerConf({
      baseConf: this.baseConf,
      components: this.components,
      values: {
        stories: this.value("stories"),
        link: this.value("link"),
        title: this.value("title"),
        timestamp: this.value("timestamp"),
        tag: this.value("tag")
      }
    })
  }

  private scheduleUpdate(): void {
    if (this.updateTimer !== null) window.clearTimeout(this.updateTimer)
    this.updateTimer = window.setTimeout(() => {
      this.updateTimer = null
      this.update()
    }, 150)
  }

  private update(): void {
    const stories = this.storyElements()
    const storiesCount = this.counts.get("stories")
    if (storiesCount) {
      storiesCount.textContent = this.value("stories")
        ? String(stories.length)
        : "–"
    }
    for (const field of FIELDS) {
      if (field.key === "stories") continue
      const count = this.counts.get(field.key)
      if (!count) continue
      const selector = this.value(field.key)
      if (!selector || stories.length === 0) {
        count.textContent = "–"
        continue
      }
      const matched = stories.filter(
        (story) => safeQueryAll(story, selector).length > 0
      ).length
      count.textContent = `${matched}/${stories.length}`
    }
    this.renderPreview(stories.length)
    this.renderSourceLine()
    this.scheduleRender()
  }

  private renderPreview(storyCount: number): void {
    this.preview.textContent = ""
    const conf = this.buildConf()
    this.saveButton.disabled = true
    if (!conf) {
      this.appendSummary(
        storyCount > 0
          ? `${storyCount} story elements matched. Set link and title to preview.`
          : "Pick or type selectors to preview stories."
      )
      return
    }
    let parsed
    try {
      parsed = genyParse(document, { url: location.href, config: conf })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.setStatus(`Preview failed: ${detail}`)
      this.appendSummary("The collector could not parse stories with these selectors.")
      return
    }
    this.setStatus("")
    if (parsed.length === 0) {
      this.appendSummary("No stories parsed from the current selection.")
      return
    }
    this.saveButton.disabled = false
    this.appendSummary(`${parsed.length} stories parsed:`)
    for (const story of parsed.slice(0, PREVIEW_LIMIT)) {
      const item = this.el("div")
      item.className = "story"
      const title = this.el("div", { text: story.title })
      title.className = "t"
      const url = this.el("div", { text: story.href })
      url.className = "u"
      item.append(title, url)
      const meta: string[] = []
      for (const tag of story.tags) meta.push(tag.text)
      if (story.timestamp) {
        const time = new Date(story.timestamp)
        if (!Number.isNaN(time.getTime())) meta.push(time.toLocaleString())
      }
      if (meta.length > 0) {
        const info = this.el("div", { text: meta.join(" · ") })
        info.className = "m"
        item.append(info)
      }
      this.preview.append(item)
    }
  }

  private appendSummary(text: string): void {
    const summary = this.el("div", { text })
    summary.className = "summary"
    this.preview.append(summary)
  }

  private buildSourceLine(conf: GenySelectorConf): string {
    return serializePickerConf(conf)
  }

  private renderSourceLine(): void {
    // Never rewrite the line under the user while they are editing it.
    if (this.shadow.activeElement === this.sourceInput) return
    this.sourceInput.value = this.buildSourceLine(this.buildLooseConf())
  }

  private scheduleSourceApply(): void {
    if (this.sourceTimer !== null) window.clearTimeout(this.sourceTimer)
    this.sourceTimer = window.setTimeout(() => {
      this.sourceTimer = null
      this.applySourceEdit()
    }, 250)
  }

  private applySourceEdit(): void {
    let warning: string
    try {
      warning = this.applySourceLine(this.sourceInput.value)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.setStatus(`Source line: ${detail}`)
      return
    }
    this.update()
    // The preview clears the status when it parses; a collector rejection of
    // the edited configuration still matters more than a green preview.
    if (warning) this.setStatus(warning)
  }

  // Parses an edited source line back into the form fields. Returns a
  // warning when the configuration parses but the collector would reject it.
  private applySourceLine(raw: string): string {
    const parsed = parsePickerConf(raw)
    this.baseConf = parsed.state.baseConf
    this.components.clear()
    for (const [field, component] of parsed.state.components) {
      this.components.set(field, component)
    }
    for (const field of FIELDS) {
      this.setValue(field.key, parsed.state.values[field.key])
    }
    return parsed.warning
  }

  private scheduleRender(): void {
    if (this.frame !== null) return
    this.frame = window.requestAnimationFrame(() => {
      this.frame = null
      this.renderBoxes()
    })
  }

  private renderBoxes(): void {
    this.boxes.textContent = ""
    const stories = this.storyElements().slice(0, MAX_HIGHLIGHTS)
    for (const story of stories) this.appendBox(story, "box")
    const fieldSelector =
      this.focusField !== "stories" ? this.value(this.focusField) : ""
    if (fieldSelector) {
      for (const story of stories.slice(0, 40)) {
        const match = safeQueryAll(story, fieldSelector)[0]
        if (match) this.appendBox(match, "box field")
      }
    }
    if (this.picking && this.hoverTarget?.isConnected) {
      this.appendBox(this.hoverTarget, "box hover")
    }
  }

  private appendBox(element: Element, className: string): void {
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0 && rect.height <= 0) return
    if (rect.bottom < 0 || rect.top > window.innerHeight) return
    const box = this.el("div")
    box.className = className
    box.style.left = `${rect.left - 2}px`
    box.style.top = `${rect.top - 2}px`
    box.style.width = `${rect.width}px`
    box.style.height = `${rect.height}px`
    this.boxes.append(box)
  }

  private setStatus(text: string): void {
    this.status.textContent = text
  }

  private save(): void {
    const conf = this.buildConf()
    if (!conf) return
    try {
      sanitize_selector_conf(conf)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.setStatus(detail)
      return
    }
    this.resolve({ conf: JSON.stringify(conf), url: location.href })
  }

  private resolve(result: SourcePickResult | null): void {
    const finish = this.finish
    if (!finish) return
    this.finish = null
    window.removeEventListener("scroll", this.onScroll, true)
    window.removeEventListener("resize", this.onScroll)
    window.removeEventListener("keydown", this.onKeyDown, true)
    window.removeEventListener("pagehide", this.onPageHide)
    if (this.updateTimer !== null) window.clearTimeout(this.updateTimer)
    if (this.sourceTimer !== null) window.clearTimeout(this.sourceTimer)
    if (this.frame !== null) window.cancelAnimationFrame(this.frame)
    this.host.remove()
    finish(result)
  }
}

let activeSession: Promise<SourcePickResult | null> | null = null

/** The keyboard dispatcher stands down while the picker owns the keyboard. */
export function isSourcePickerOpen(): boolean {
  return activeSession !== null
}

// Starts the picker overlay, or returns the already running session so a
// second injection focuses the existing overlay instead of stacking one.
export function startSourcePicker(): Promise<SourcePickResult | null> {
  if (!activeSession) {
    activeSession = new PickerOverlay().run().finally(() => {
      activeSession = null
    })
  }
  return activeSession
}
