import {
  GenySelector,
  GenySelectorConf,
  options as genyOptions,
  parse as genyParse,
  sanitize_selector_conf
} from "@once/collectors/geny"

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

function escapeCssIdent(value: string): string {
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(value)
  return value.replace(/[^a-zA-Z0-9_-]/g, (match) => `\\${match}`)
}

function safeQueryAll(root: Element, selector: string): Element[] {
  if (!selector.trim()) return []
  try {
    return Array.from(root.querySelectorAll(selector))
  } catch {
    return []
  }
}

// "div.story.item" style segment for one element (tag plus up to three classes).
export function cssSegment(element: Element): string {
  const tag = element.tagName.toLowerCase()
  const classes = Array.from(element.classList)
    .filter((name) => !/^\d/.test(name))
    .slice(0, 3)
    .map((name) => `.${escapeCssIdent(name)}`)
  return tag + classes.join("")
}

// Generalizes a clicked element into a selector matching the repeated story
// containers: walks the ancestors and keeps the candidate matching the most
// elements that contain a link, preferring the outermost candidate on ties
// so the container keeps tags and timestamps next to the clicked title.
export function generalizeStorySelector(element: Element): string {
  const doc = element.ownerDocument
  if (!doc?.body) return cssSegment(element)
  let best: { selector: string; score: number } | null = null

  let candidate: Element | null = element
  for (let depth = 0; candidate && candidate !== doc.body && depth < 15; depth++) {
    let selector = cssSegment(candidate)
    const parent: Element | null = candidate.parentElement
    if (candidate.classList.length === 0 && parent && parent !== doc.body) {
      selector = `${cssSegment(parent)} > ${selector}`
    }
    const matches = safeQueryAll(doc.body, selector)
    const score = matches.filter((match) => match.querySelector("a[href]")).length
    if (score >= 2 && (!best || score >= best.score)) {
      best = { selector, score }
    }
    candidate = parent
  }
  return best ? best.selector : cssSegment(element)
}

function nthOfType(element: Element): number {
  let index = 1
  let sibling = element.previousElementSibling
  while (sibling) {
    if (sibling.tagName === element.tagName) index++
    sibling = sibling.previousElementSibling
  }
  return index
}

// Builds a selector for an element relative to its story container so that
// story.querySelectorAll(selector)[0] finds the element, preferring short
// descendant selectors over full child paths.
export function relativeFieldSelector(root: Element, element: Element): string | null {
  if (element === root || !root.contains(element)) return null

  const short = cssSegment(element)
  if (safeQueryAll(root, short)[0] === element) return short

  const parts: string[] = []
  let current: Element = element
  while (current !== root) {
    const parent: Element | null = current.parentElement
    if (!parent) break
    let segment = cssSegment(current)
    const twins = Array.from(parent.children).filter(
      (child) => child.tagName === current.tagName
    )
    if (twins.length > 1) segment += `:nth-of-type(${nthOfType(current)})`
    parts.unshift(segment)
    const candidate = parts.join(" > ")
    if (safeQueryAll(root, candidate)[0] === element) return candidate
    current = parent
  }
  return parts.join(" > ")
}

const OVERLAY_STYLES = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  #boxes, #catcher {
    position: fixed;
    inset: 0;
    margin: 0;
  }
  #boxes { pointer-events: none; z-index: 1; }
  .box {
    position: absolute;
    pointer-events: none;
    border: 2px solid #3a76d0;
    background: rgba(58, 118, 208, 0.12);
    border-radius: 2px;
  }
  .box.field {
    border-color: #d07a3a;
    background: rgba(208, 122, 58, 0.18);
  }
  .box.hover {
    border-color: #2fa463;
    background: rgba(47, 164, 99, 0.18);
  }
  #catcher { z-index: 2; cursor: crosshair; display: none; }
  #hoverhint {
    position: fixed;
    z-index: 4;
    display: none;
    max-width: 60vw;
    padding: 3px 7px;
    font: 11px/1.4 Consolas, monospace;
    color: #e8eaf2;
    background: #20242f;
    border: 1px solid #3a76d0;
    border-radius: 3px;
    pointer-events: none;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  #panel {
    position: fixed;
    right: 14px;
    bottom: 14px;
    z-index: 3;
    width: 380px;
    max-width: calc(100vw - 28px);
    max-height: calc(100vh - 28px);
    overflow: auto;
    font: 12px/1.45 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #e8eaf2;
    background: #262a35;
    border: 1px solid #444b5d;
    border-radius: 6px;
    padding: 12px;
  }
  #panel h1 {
    font-size: 13px;
    font-weight: 600;
    margin: 0 0 8px;
  }
  .row {
    display: grid;
    grid-template-columns: 52px 1fr auto auto;
    gap: 6px;
    align-items: center;
    margin-bottom: 6px;
  }
  .row label { color: #aab1c2; }
  .row input[type="text"] {
    width: 100%;
    min-width: 0;
    padding: 3px 6px;
    font: 11px Consolas, monospace;
    color: #e8eaf2;
    background: #1b1e26;
    border: 1px solid #444b5d;
    border-radius: 3px;
  }
  .row input[type="text"]:focus { outline: 1px solid #3a76d0; }
  .row .count {
    min-width: 26px;
    text-align: right;
    color: #8f97a8;
    font-variant-numeric: tabular-nums;
  }
  button {
    padding: 3px 9px;
    font: 11px -apple-system, "Segoe UI", sans-serif;
    color: #e8eaf2;
    background: #333a4a;
    border: 1px solid #4c5468;
    border-radius: 3px;
    cursor: pointer;
  }
  button:hover { background: #40495e; }
  button.picking { background: #3a76d0; border-color: #3a76d0; }
  button:disabled { opacity: 0.45; cursor: default; }
  #status {
    min-height: 16px;
    margin: 4px 0;
    color: #ffb37a;
    word-break: break-word;
  }
  #preview {
    margin-top: 6px;
    border-top: 1px solid #444b5d;
    padding-top: 6px;
  }
  #preview .summary { color: #8f97a8; margin-bottom: 6px; }
  #preview .story {
    padding: 4px 6px;
    margin-bottom: 4px;
    background: #1b1e26;
    border-radius: 3px;
  }
  #preview .story .t { color: #e8eaf2; }
  #preview .story .u, #preview .story .m {
    color: #8f97a8;
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  #source { margin-top: 6px; }
  #source label {
    display: block;
    color: #aab1c2;
    margin-bottom: 2px;
  }
  #source textarea {
    width: 100%;
    min-height: 48px;
    resize: vertical;
    padding: 4px 6px;
    font: 10px/1.5 Consolas, monospace;
    color: #e8eaf2;
    background: #1b1e26;
    border: 1px solid #444b5d;
    border-radius: 3px;
    word-break: break-all;
  }
  #source textarea:focus { outline: 1px solid #3a76d0; }
  #actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 8px;
  }
  #actions .save { background: #2fa463; border-color: #2fa463; }
  #actions .save:hover { background: #37b56f; }
`

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
    this.host.style.cssText =
      "all: initial; position: fixed; top: 0; left: 0; z-index: 2147483647;"
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
      this.hoverHint.style.display = "none"
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
      this.hoverHint.style.display = "none"
      return
    }
    this.hoverHint.textContent = this.hoverSelector(this.hoverTarget)
    this.hoverHint.style.display = "block"
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
    this.hoverHint.style.display = "none"
    this.catcher.style.display = field ? "block" : "none"
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
    const conf = JSON.parse(JSON.stringify(this.baseConf)) as GenySelectorConf
    this.applyFieldSlot(conf, "stories", { all: true })
    this.applyFieldSlot(conf, "link", {
      component: this.components.get("link") || "href"
    })
    this.applyFieldSlot(conf, "title", {
      component: "innerText",
      processors: ["trim"]
    })
    this.applyFieldSlot(conf, "timestamp", {
      component: this.components.get("timestamp") || "innerText"
    })

    const tag = this.value("tag")
    const baseTagText = conf.tags?.[0]?.elements?.text
    if (!tag) {
      delete conf.tags
    } else if (baseTagText?.sel !== tag) {
      conf.tags = [
        {
          elements: {
            text: { sel: tag, component: this.components.get("tag") || "innerText" }
          }
        }
      ]
    }
    // Cleared fields leave undefined-valued keys behind; serialize them away
    // so validation sees the same configuration that will be saved.
    return JSON.parse(JSON.stringify(conf)) as GenySelectorConf
  }

  private applyFieldSlot(
    conf: GenySelectorConf,
    field: "stories" | "link" | "title" | "timestamp",
    defaults: GenySelector
  ): void {
    const sel = this.value(field)
    if (!sel) {
      // undefined slots disappear when the configuration is serialized.
      conf[field] = undefined
    } else if (conf[field]?.sel !== sel) {
      conf[field] = { ...defaults, sel }
    }
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
      const source = this.buildSourceLine(conf)
      parsed = genyParse(document, location.href, source)
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
    const separator = genyOptions.separator
    return `geny:${separator}${JSON.stringify(conf)}${separator}${location.href}`
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
    const separator = genyOptions.separator
    const parts = raw.trim().split(separator)
    if (!parts[0].startsWith("geny:") || parts.length < 3) {
      throw new Error(
        `expected geny:${separator}{"stories":…}${separator}${location.origin}…`
      )
    }
    const parsed: unknown = JSON.parse(parts[1])
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("the configuration must be a JSON object")
    }
    const conf = parsed as GenySelectorConf
    this.baseConf = conf
    this.applyFieldSelector("stories", conf.stories)
    this.applyFieldSelector("link", conf.link)
    this.applyFieldSelector("title", conf.title)
    this.applyFieldSelector("timestamp", conf.timestamp)
    const tagText = conf.tags?.[0]?.elements?.text
    this.setValue("tag", tagText?.sel || "")
    if (tagText?.component) this.components.set("tag", tagText.component)
    try {
      sanitize_selector_conf(conf)
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
    return ""
  }

  private applyFieldSelector(field: FieldKey, selector?: GenySelector): void {
    this.setValue(field, selector?.sel || "")
    if (selector?.component) this.components.set(field, selector.component)
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
