import {
  DEFAULT_SWIPE_SETTINGS,
  normalizeSwipeSettings,
  OnceClient,
  SWIPE_ACTION_LABELS,
  SwipeActionId,
  SwipeSettings
} from "@once/app"
import { installSwipePreview } from "./swipePreviewRow"

const SAVE_DEBOUNCE_MS = 700
const MIN_THRESHOLD = 16
const MIN_STAGE_GAP = 16

type Direction = "right" | "left"
type StageIndex = 0 | 1

interface QueuedSave {
  snapshot: SwipeSettings
  undo: SwipeSettings | null
}

function copy(settings: SwipeSettings): SwipeSettings {
  return normalizeSwipeSettings(settings)
}

function same(a: SwipeSettings, b: SwipeSettings): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  return node
}

/**
 * Interactive, autosaving editor for the story-row swipe gesture.
 *
 * The component owns an immutable local snapshot. Writes are serialized and
 * never reread mutable controls, so an older save cannot roll a newer edit
 * backward when OnceApp publishes settingsChanged.
 */
export class SwipeSettingsLab {
  private current = copy(DEFAULT_SWIPE_SETTINGS)
  private saved = copy(DEFAULT_SWIPE_SETTINGS)
  private pendingUndo: SwipeSettings | null = null
  private undoTarget: SwipeSettings | null = null
  private saveTimer?: ReturnType<typeof setTimeout>
  private queued?: QueuedSave
  private saving = false
  private failed = false
  private externalChangePending = false
  private ownSaveEvent = false
  private travel = 0
  private readonly selects = new Map<string, HTMLSelectElement>()
  private readonly handles = new Map<string, HTMLButtonElement>()
  private readonly zones = new Map<string, HTMLElement>()
  private readonly twoStage: HTMLInputElement
  private readonly sticky: HTMLInputElement
  private readonly stickyStrength: HTMLInputElement
  private readonly stickyOutput: HTMLOutputElement
  private readonly fastMode: HTMLInputElement
  private readonly lockIn: HTMLInputElement
  private readonly lockOutput: HTMLOutputElement
  private readonly status: HTMLElement
  private readonly undo: HTMLButtonElement
  private readonly scroller: HTMLElement
  private readonly inner: HTMLElement
  private readonly track: HTMLElement
  private readonly marker: HTMLElement
  private readonly resizeObserver: ResizeObserver

  constructor(
    private readonly host: HTMLElement,
    private readonly client: OnceClient,
    private readonly onUiChanged: () => void
  ) {
    host.textContent = ""

    this.scroller = element("div", "swipe_lab_scroller")
    this.inner = element("div", "swipe_lab_inner")
    this.scroller.append(this.inner)
    host.append(this.scroller)

    const actions = element("div", "swipe_action_blocks")
    actions.append(
      this.buildDirection("right"),
      this.buildDirection("left")
    )
    this.inner.append(actions)

    this.track = element("div", "swipe_ruler")
    this.track.dataset.testid = "swipe-ruler"
    for (const key of [
      "right-dead",
      "right-1",
      "right-2",
      "left-2",
      "left-1",
      "left-dead"
    ]) {
      const zone = element("div", "swipe_ruler_zone")
      zone.dataset.zone = key
      zone.dataset.testid = `swipe-zone-${key}`
      const label = element("span", "swipe_ruler_zone_label")
      zone.append(label)
      this.zones.set(key, zone)
      this.track.append(zone)
    }
    for (const direction of ["right", "left"] as const) {
      for (const stage of [0, 1] as const) {
        const handle = element("button", "swipe_ruler_handle")
        handle.type = "button"
        handle.setAttribute("role", "slider")
        handle.dataset.handle = `${direction}-${stage}`
        handle.dataset.testid = `swipe-handle-${direction}-${stage + 1}`
        handle.setAttribute(
          "aria-label",
          `Swipe ${direction} stage ${stage + 1} distance`
        )
        const value = element("span", "swipe_ruler_value")
        handle.append(value)
        this.installHandle(handle, direction, stage)
        this.handles.set(`${direction}-${stage}`, handle)
        this.track.append(handle)
      }
    }
    this.marker = element("div", "swipe_ruler_marker")
    this.marker.setAttribute("aria-hidden", "true")
    this.track.append(this.marker)
    this.inner.append(this.track)

    const preview = element("div", "swipe_lab_preview")
    preview.id = "swipe_preview"
    preview.dataset.testid = "swipe-preview"
    this.inner.append(preview)
    installSwipePreview(preview, () => this.current, (offset) => {
      this.travel = offset
      this.layout()
    })

    const advanced = element("details", "swipe_advanced")
    advanced.dataset.testid = "swipe-advanced"
    const summary = element("summary")
    summary.textContent = "Advanced — stage feel"
    advanced.append(summary)
    const advancedBody = element("div", "swipe_advanced_body")
    advanced.append(advancedBody)

    this.twoStage = this.checkbox(
      advancedBody,
      "swipe_two_stage",
      "Two-stage swipe"
    )
    advancedBody.append(this.description(
      "Drag farther to reveal and run a second action."
    ))
    this.sticky = this.checkbox(
      advancedBody,
      "swipe_sticky_stages",
      "Sticky stages"
    )
    advancedBody.append(this.description(
      "The row snaps to the nearest stage as you drag, so a threshold is easy to feel and hold."
    ))
    ;[this.stickyStrength, this.stickyOutput] = this.slider(
      advancedBody,
      "swipe_sticky_strength",
      "Stickiness",
      1,
      100,
      1
    )
    this.fastMode = this.checkbox(
      advancedBody,
      "swipe_fast_mode",
      "Fast swipe mode"
    )
    advancedBody.append(this.description(
      "Past stage 2 the swipe must be held briefly before release, so a quick flick cannot fire it."
    ))
    ;[this.lockIn, this.lockOutput] = this.slider(
      advancedBody,
      "swipe_stage_2_lock_in",
      "Stage 2 lock-in",
      75,
      500,
      25
    )
    host.append(advanced)

    const footer = element("div", "swipe_footer")
    this.status = element("span", "swipe_save_status")
    this.status.dataset.testid = "swipe-save-status"
    this.status.setAttribute("role", "status")
    this.status.setAttribute("aria-live", "polite")
    this.undo = element("button")
    this.undo.type = "button"
    this.undo.textContent = "undo"
    this.undo.dataset.testid = "undo-swipe"
    const reset = element("button")
    reset.type = "button"
    reset.textContent = "reset to defaults"
    reset.dataset.testid = "reset-swipe"
    footer.append(this.status, this.undo, reset)
    host.append(footer)

    this.twoStage.addEventListener("change", () =>
      this.change({ twoStage: this.twoStage.checked }))
    this.sticky.addEventListener("change", () =>
      this.change({ stickyStages: this.sticky.checked }))
    this.stickyStrength.addEventListener("input", () =>
      this.change({ stickyStrength: Number(this.stickyStrength.value) }))
    this.fastMode.addEventListener("change", () =>
      this.change({ fastSwipeMode: this.fastMode.checked }))
    this.lockIn.addEventListener("input", () =>
      this.change({ stage2LockInMs: Number(this.lockIn.value) }))
    this.undo.addEventListener("click", () => this.undoLastBatch())
    reset.addEventListener("click", () => this.replace(DEFAULT_SWIPE_SETTINGS))

    this.resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => this.layout())
    })
    this.resizeObserver.observe(this.scroller)
    void this.restore()
  }

  private buildDirection(direction: Direction): HTMLElement {
    const block = element("section", `swipe_action_block swipe_action_${direction}`)
    const heading = element("div", "swipe_action_heading")
    const title = element("strong")
    title.textContent = direction === "right" ? "Swipe right" : "Swipe left"
    const explanation = element("span")
    explanation.textContent =
      direction === "right"
        ? "→ reveals from the left"
        : "reveals from the right ←"
    heading.append(
      ...(direction === "right"
        ? [title, explanation]
        : [explanation, title])
    )
    block.append(heading)

    for (const stage of [0, 1] as const) {
      const label = element("label", "swipe_action_field")
      label.dataset.stage = String(stage + 1)
      const stageLabel = element("span", "swipe_stage_label")
      stageLabel.textContent = stage === 0 ? "1st" : "2nd"
      const select = element("select")
      select.dataset.swipe = `${direction}-${stage}`
      select.dataset.testid = `swipe-${direction}-${stage + 1}`
      select.setAttribute(
        "aria-label",
        `Stage ${stage + 1} swipe ${direction} action`
      )
      for (const [id, text] of Object.entries(SWIPE_ACTION_LABELS)) {
        const option = element("option")
        option.value = id
        option.textContent = text
        select.append(option)
      }
      select.addEventListener("change", () => {
        const values = [...this.current[direction]] as [
          SwipeActionId,
          SwipeActionId
        ]
        values[stage] = select.value as SwipeActionId
        this.change({ [direction]: values })
      })
      label.append(
        ...(direction === "right"
          ? [stageLabel, select]
          : [select, stageLabel])
      )
      this.selects.set(`${direction}-${stage}`, select)
      block.append(label)
    }
    return block
  }

  private checkbox(
    host: HTMLElement,
    id: string,
    labelText: string,
    hint?: string
  ): HTMLInputElement {
    const row = element("p", "swipe_check_row")
    const input = element("input")
    input.type = "checkbox"
    input.id = id
    const label = element("label")
    label.htmlFor = id
    label.textContent = labelText
    row.append(input, label)
    if (hint) {
      const text = element("span", "swipe_inline_hint")
      text.textContent = `— ${hint}`
      row.append(text)
    }
    host.append(row)
    return input
  }

  private description(text: string): HTMLElement {
    const description = element("p", "swipe_advanced_description")
    description.textContent = text
    return description
  }

  private slider(
    host: HTMLElement,
    id: string,
    labelText: string,
    min: number,
    max: number,
    step: number
  ): [HTMLInputElement, HTMLOutputElement] {
    const row = element("p", "swipe_slider_row")
    const label = element("label")
    label.htmlFor = id
    label.textContent = labelText
    const input = element("input")
    input.type = "range"
    input.id = id
    input.min = String(min)
    input.max = String(max)
    input.step = String(step)
    const output = element("output")
    output.htmlFor = id
    row.append(label, input, output)
    host.append(row)
    return [input, output]
  }

  private installHandle(
    handle: HTMLButtonElement,
    direction: Direction,
    stage: StageIndex
  ): void {
    const setFromClientX = (clientX: number): void => {
      const box = this.track.getBoundingClientRect()
      const raw =
        direction === "right" ? clientX - box.left : box.right - clientX
      this.setThreshold(stage, Math.round(raw))
    }
    handle.addEventListener("pointerdown", (event) => {
      event.preventDefault()
      handle.setPointerCapture(event.pointerId)
      setFromClientX(event.clientX)
    })
    handle.addEventListener("pointermove", (event) => {
      if (!handle.hasPointerCapture(event.pointerId)) return
      setFromClientX(event.clientX)
    })
    handle.addEventListener("keydown", (event) => {
      const current = this.current.stages[stage].threshold
      const step = event.shiftKey ? 10 : 1
      let next: number | undefined
      if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
        next = current - step
      } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
        next = current + step
      } else if (event.key === "Home") {
        next = stage === 0
          ? MIN_THRESHOLD
          : this.current.stages[0].threshold + MIN_STAGE_GAP
      } else if (event.key === "End") {
        next = Math.round(this.track.clientWidth / 2)
      }
      if (next === undefined) return
      event.preventDefault()
      this.setThreshold(stage, next)
    })
  }

  private setThreshold(stage: StageIndex, raw: number): void {
    const stages = this.current.stages.map((value) => ({ ...value })) as
      SwipeSettings["stages"]
    const maximum = Math.round(this.track.clientWidth / 2)
    if (stage === 0) {
      stages[0].threshold = Math.min(
        Math.max(MIN_THRESHOLD, raw),
        stages[1].threshold - MIN_STAGE_GAP
      )
    } else {
      stages[1].threshold = Math.min(
        Math.max(stages[0].threshold + MIN_STAGE_GAP, raw),
        maximum
      )
    }
    this.change({ stages })
  }

  private change(patch: Partial<SwipeSettings>): void {
    this.replace({ ...this.current, ...patch })
  }

  private replace(
    settings: SwipeSettings,
    options: { undoable?: boolean } = {}
  ): void {
    const next = copy(settings)
    if (same(next, this.current)) return
    if (options.undoable !== false && !this.pendingUndo) {
      this.pendingUndo = copy(this.current)
    }
    this.current = next
    this.failed = false
    this.undoTarget = null
    this.render()
    this.status.textContent = "saving…"
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => this.queueCurrent(), SAVE_DEBOUNCE_MS)
    this.onUiChanged()
  }

  private queueCurrent(): void {
    this.saveTimer = undefined
    this.queued = {
      snapshot: copy(this.current),
      undo: this.pendingUndo ? copy(this.pendingUndo) : null
    }
    this.pendingUndo = null
    void this.drainSaves()
  }

  private async drainSaves(): Promise<void> {
    if (this.saving || !this.queued) return
    const request = this.queued
    this.queued = undefined
    this.saving = true
    this.ownSaveEvent = true
    try {
      await this.client.setSwipeSettings(request.snapshot)
      this.saved = copy(request.snapshot)
      this.undoTarget = request.undo ? copy(request.undo) : null
      this.failed = false
    } catch (error) {
      console.error("Failed to save swipe settings", error)
      this.failed = true
      this.queued = request
    } finally {
      this.ownSaveEvent = false
      this.saving = false
    }

    if (!this.failed && this.queued) {
      void this.drainSaves()
      return
    }
    if (this.externalChangePending && !this.hasLocalWork()) {
      this.externalChangePending = false
      await this.restore()
      return
    }
    this.renderStatus()
  }

  private undoLastBatch(): void {
    if (!this.undoTarget || this.hasLocalWork()) return
    const target = copy(this.undoTarget)
    this.undoTarget = null
    this.replace(target, { undoable: false })
  }

  private hasLocalWork(): boolean {
    return Boolean(this.saveTimer || this.saving || this.queued)
  }

  async restore(): Promise<void> {
    const settings = copy(await this.client.getSwipeSettings())
    if (this.hasLocalWork()) {
      this.externalChangePending = true
      return
    }
    this.current = settings
    this.saved = copy(settings)
    this.pendingUndo = null
    this.undoTarget = null
    this.failed = false
    this.render()
  }

  externalSettingsChanged(): void {
    if (this.ownSaveEvent) return
    if (this.hasLocalWork()) {
      this.externalChangePending = true
      return
    }
    void this.restore()
  }

  private render(): void {
    this.twoStage.checked = this.current.twoStage
    this.sticky.checked = this.current.stickyStages
    this.stickyStrength.value = String(this.current.stickyStrength)
    this.stickyOutput.value = String(this.current.stickyStrength)
    this.fastMode.checked = this.current.fastSwipeMode
    this.lockIn.value = String(this.current.stage2LockInMs)
    this.lockOutput.value = `${this.current.stage2LockInMs} ms`
    this.stickyStrength.disabled = !this.current.stickyStages
    this.stickyStrength.closest("p")?.classList.toggle(
      "disabled",
      !this.current.stickyStages
    )
    this.fastMode.disabled = !this.current.twoStage
    this.fastMode.closest("p")?.classList.toggle(
      "disabled",
      !this.current.twoStage
    )
    this.lockIn.disabled =
      !this.current.twoStage || !this.current.fastSwipeMode
    this.lockIn.closest("p")?.classList.toggle("disabled", this.lockIn.disabled)
    for (const direction of ["right", "left"] as const) {
      for (const stage of [0, 1] as const) {
        const select = this.selects.get(`${direction}-${stage}`)
        if (!select) continue
        select.value = this.current[direction][stage]
        select.disabled = stage === 1 && !this.current.twoStage
        select.dataset.action = select.value
        const field = select.closest<HTMLLabelElement>("label")
        field?.classList.toggle("disabled", select.disabled)
        if (field) field.dataset.action = select.value
      }
    }
    // width: 100% supplies the presentation minimum. Only make the lab wider
    // than its viewport when exact 1px-per-pixel threshold geometry requires
    // it; a fixed minimum needlessly clipped ordinary settings on Android.
    this.syncInnerMinWidth()
    this.renderStatus()
    requestAnimationFrame(() => this.layout())
  }

  private renderStatus(): void {
    if (this.failed) {
      this.status.textContent = "changes not saved — edit to retry"
    } else if (this.hasLocalWork()) {
      this.status.textContent = "saving…"
    } else {
      this.status.textContent = "all changes saved"
    }
    this.undo.disabled = !this.undoTarget || this.hasLocalWork()
  }

  private layout(): void {
    this.syncInnerMinWidth()
    const width = this.track.clientWidth
    if (!width) return
    const half = Math.round(width / 2)
    const [first, second] = this.current.stages.map((stage) => stage.threshold)
    // On an odd-width ruler, mirroring the rounded maximum puts the two
    // stage-2 handles one pixel apart (for example 252px and 251px in 503px).
    // Once stage 2 reaches that maximum, give both sides the same geometric
    // centre so the handles and zone seam paint on precisely the same pixel.
    const secondPosition = second >= half ? width / 2 : second
    const zone = (
      key: string,
      from: number,
      to: number,
      action: SwipeActionId,
      disabled = false
    ): void => {
      const node = this.zones.get(key)
      if (!node) return
      node.style.left = `${Math.round(from)}px`
      node.style.width = `${Math.max(0, Math.round(to - from))}px`
      node.dataset.action = action
      node.classList.toggle("disabled", disabled)
      const text = SWIPE_ACTION_LABELS[action]
      const label = node.querySelector<HTMLElement>(".swipe_ruler_zone_label")
      if (!label) return
      label.textContent = text
      const room = node.clientWidth - 2 * (this.handleWidth() + 4)
      if (this.textWidth(label, text) + 4 > room) {
        label.textContent = ""
      }
    }
    zone("right-dead", 0, first, "none")
    zone(
      "right-2",
      this.current.twoStage ? secondPosition : half,
      half,
      this.current.right[1],
      !this.current.twoStage
    )
    zone(
      "right-1",
      first,
      this.current.twoStage ? secondPosition : half,
      this.current.right[0]
    )
    zone(
      "left-2",
      half,
      this.current.twoStage ? width - secondPosition : half,
      this.current.left[1],
      !this.current.twoStage
    )
    zone("left-dead", width - first, width, "none")
    zone(
      "left-1",
      width - (this.current.twoStage ? secondPosition : half),
      width - first,
      this.current.left[0]
    )

    for (const direction of ["right", "left"] as const) {
      for (const stage of [0, 1] as const) {
        const handle = this.handles.get(`${direction}-${stage}`)
        if (!handle) continue
        const threshold = this.current.stages[stage].threshold
        const position = stage === 1 ? secondPosition : threshold
        const x = direction === "right" ? position : width - position
        handle.style.left = `${Math.round(x)}px`
        handle.classList.toggle(
          "disabled",
          stage === 1 && !this.current.twoStage
        )
        handle.disabled = stage === 1 && !this.current.twoStage
        handle.setAttribute("aria-valuemin", String(
          stage === 0 ? MIN_THRESHOLD : first + MIN_STAGE_GAP
        ))
        handle.setAttribute("aria-valuemax", String(half))
        handle.setAttribute("aria-valuenow", String(threshold))
        const value = handle.querySelector<HTMLElement>(".swipe_ruler_value")
        if (value) {
          value.textContent =
            stage === 1 && !this.current.twoStage ? "" : `${threshold}px`
        }
      }
    }
    const markerX = this.travel >= 0 ? this.travel : width + this.travel
    this.marker.style.left = `${Math.round(markerX)}px`
    this.marker.classList.toggle("active", this.travel !== 0)
  }

  private measureContext?: CanvasRenderingContext2D | null

  private syncInnerMinWidth(): void {
    const required = this.current.stages[1].threshold * 2
    const available = this.scroller.clientWidth
    // An odd-width ruler can leave a previously saved midpoint one pixel
    // wider than its viewport. Treat that rounding residue as a fit so it
    // cannot create document overflow or revive the horizontal scrollbar.
    const minWidth =
      available > 0 && required <= available + 1
        ? "100%"
        : `${required}px`
    if (this.inner.style.minWidth !== minWidth) {
      this.inner.style.minWidth = minWidth
    }
  }

  private handleWidth(): number {
    const handle = this.handles.values().next().value as
      HTMLButtonElement | undefined
    return handle?.offsetWidth ?? 14
  }

  private textWidth(node: HTMLElement, text: string): number {
    this.measureContext ??= document.createElement("canvas").getContext("2d")
    if (!this.measureContext) return text.length * 8
    const style = getComputedStyle(node)
    this.measureContext.font =
      `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
    return this.measureContext.measureText(text).width
  }
}
