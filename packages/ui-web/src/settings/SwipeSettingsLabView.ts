import {
  onSwipeActionsChanged,
  swipeActionLabel,
  SwipeActionId,
  SwipeSettings
} from "@once/app"
import { syncSwipeActionOptions } from "./swipeActionOptions"
import { installSwipePreview } from "./swipePreviewRow"

const MIN_THRESHOLD = 16
const MIN_STAGE_GAP = 16

type Direction = "right" | "left"
type StageIndex = 0 | 1

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  return node
}

interface AdvancedControls {
  undoSnackbar: HTMLInputElement
  undoSnackbarDuration: HTMLInputElement
  undoSnackbarDurationOutput: HTMLOutputElement
  twoStage: HTMLInputElement
  sticky: HTMLInputElement
  stickyStrength: HTMLInputElement
  stickyOutput: HTMLOutputElement
  fastMode: HTMLInputElement
  lockIn: HTMLInputElement
  lockOutput: HTMLOutputElement
}

function checkbox(
  host: HTMLElement,
  id: string,
  labelText: string
): HTMLInputElement {
  const row = element("p", "swipe_check_row row")
  const input = element("input")
  input.type = "checkbox"
  input.id = id
  const label = element("label")
  label.htmlFor = id
  label.textContent = labelText
  row.append(input, label)
  host.append(row)
  return input
}

function description(text: string): HTMLElement {
  const node = element("p", "swipe_advanced_description field_hint")
  node.textContent = text
  return node
}

function slider(
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

function buildAdvancedControls(host: HTMLElement): AdvancedControls {
  const advanced = element("details", "swipe_advanced")
  advanced.dataset.testid = "swipe-advanced"
  const summary = element("summary", "settings_subheading")
  summary.textContent = "Advanced"
  const body = element("div", "swipe_advanced_body")
  advanced.append(summary, body)

  const mobileUndo = element("div", "swipe_mobile_only")
  const undoSnackbar = checkbox(
    mobileUndo,
    "swipe_undo_snackbar",
    "Show mobile undo snackbar"
  )
  mobileUndo.append(description(
    "Offers to reverse recent story changes at the bottom of the mobile screen."
  ))
  const [undoSnackbarDuration, undoSnackbarDurationOutput] = slider(
    mobileUndo, "swipe_undo_snackbar_duration", "Undo time", 1000, 10000, 500
  )
  body.append(mobileUndo)

  const twoStage = checkbox(body, "swipe_two_stage", "Two-stage swipe")
  body.append(description(
    "Drag farther to reveal and run a second action."
  ))
  const sticky = checkbox(body, "swipe_sticky_stages", "Sticky stages")
  body.append(description(
    "The row snaps to the nearest stage as you drag, so a threshold is easy to feel and hold."
  ))
  const [stickyStrength, stickyOutput] = slider(
    body, "swipe_sticky_strength", "Stickiness", 1, 100, 1
  )
  const fastMode = checkbox(body, "swipe_fast_mode", "Fast swipe mode")
  body.append(description(
    "Past stage 2 the swipe must be held briefly before release, so a quick flick cannot fire it."
  ))
  const [lockIn, lockOutput] = slider(
    body, "swipe_stage_2_lock_in", "Stage 2 lock-in", 75, 500, 25
  )
  host.append(advanced)
  return {
    undoSnackbar,
    undoSnackbarDuration,
    undoSnackbarDurationOutput,
    twoStage,
    sticky,
    stickyStrength,
    stickyOutput,
    fastMode,
    lockIn,
    lockOutput
  }
}

function buildFooter(host: HTMLElement): {
  status: HTMLElement
  undo: HTMLButtonElement
  reset: HTMLButtonElement
} {
  const footer = element("div", "swipe_footer row")
  const status = element("span", "swipe_save_status settings_status")
  status.dataset.testid = "swipe-save-status"
  status.setAttribute("role", "status")
  status.setAttribute("aria-live", "polite")
  const undo = element("button", "button")
  undo.type = "button"
  undo.textContent = "Undo"
  undo.dataset.testid = "undo-swipe"
  const reset = element("button", "button")
  reset.type = "button"
  reset.textContent = "Reset to defaults"
  reset.dataset.testid = "reset-swipe"
  footer.append(status, undo, reset)
  host.append(footer)
  return { status, undo, reset }
}

export interface SwipeSettingsLabViewActions {
  replace(settings: SwipeSettings): void
  update(patch: Partial<SwipeSettings>): void
  undo(): void
}

export interface SwipeSettingsLabViewState {
  settings: SwipeSettings
  status: "saved" | "saving" | "failed"
  canUndo: boolean
}

/** Owns the swipe-settings controls, preview, and exact ruler geometry. */
export class SwipeSettingsLabView {
  private state: SwipeSettingsLabViewState
  private travel = 0
  private readonly selects = new Map<string, HTMLSelectElement>()
  private readonly handles = new Map<string, HTMLButtonElement>()
  private readonly zones = new Map<string, HTMLElement>()
  private readonly twoStage: HTMLInputElement
  private readonly undoSnackbar: HTMLInputElement
  private readonly undoSnackbarDuration: HTMLInputElement
  private readonly undoSnackbarDurationOutput: HTMLOutputElement
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
    host: HTMLElement,
    initialSettings: SwipeSettings,
    private readonly actions: SwipeSettingsLabViewActions
  ) {
    this.state = {
      settings: initialSettings,
      status: "saved",
      canUndo: false
    }
    host.textContent = ""
    onSwipeActionsChanged(() => this.render())

    this.scroller = element("div", "swipe_lab_scroller")
    this.inner = element("div", "swipe_lab_inner")
    this.scroller.append(this.inner)
    host.append(this.scroller)

    const actionBlocks = element("div", "swipe_action_blocks")
    actionBlocks.append(
      this.buildDirection("right"),
      this.buildDirection("left")
    )
    this.inner.append(actionBlocks)

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
    installSwipePreview(preview, () => this.state.settings, (offset) => {
      this.travel = offset
      this.layout()
    })

    const controls = buildAdvancedControls(host)
    this.undoSnackbar = controls.undoSnackbar
    this.undoSnackbarDuration = controls.undoSnackbarDuration
    this.undoSnackbarDurationOutput = controls.undoSnackbarDurationOutput
    this.twoStage = controls.twoStage
    this.sticky = controls.sticky
    this.stickyStrength = controls.stickyStrength
    this.stickyOutput = controls.stickyOutput
    this.fastMode = controls.fastMode
    this.lockIn = controls.lockIn
    this.lockOutput = controls.lockOutput

    const footer = buildFooter(host)
    this.status = footer.status
    this.undo = footer.undo

    this.twoStage.addEventListener("change", () =>
      this.actions.update({ twoStage: this.twoStage.checked }))
    this.undoSnackbar.addEventListener("change", () =>
      this.actions.update({ undoSnackbarEnabled: this.undoSnackbar.checked }))
    this.undoSnackbarDuration.addEventListener("input", () =>
      this.actions.update({
        undoSnackbarDurationMs: Number(this.undoSnackbarDuration.value)
      }))
    this.sticky.addEventListener("change", () =>
      this.actions.update({ stickyStages: this.sticky.checked }))
    this.stickyStrength.addEventListener("input", () =>
      this.actions.update({
        stickyStrength: Number(this.stickyStrength.value)
      }))
    this.fastMode.addEventListener("change", () =>
      this.actions.update({ fastSwipeMode: this.fastMode.checked }))
    this.lockIn.addEventListener("input", () =>
      this.actions.update({ stage2LockInMs: Number(this.lockIn.value) }))
    this.undo.addEventListener("click", () => this.actions.undo())
    footer.reset.addEventListener("click", () =>
      this.actions.replace(initialSettings))

    this.resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => this.layout())
    })
    this.resizeObserver.observe(this.scroller)
    this.render()
  }

  private buildDirection(direction: Direction): HTMLElement {
    const block = element("section", `swipe_action_block stack swipe_action_${direction}`)
    const heading = element("div", "swipe_action_heading row")
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
      const label = element("label", "swipe_action_field row")
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
      syncSwipeActionOptions(select,this.state.settings[direction][stage])
      select.addEventListener("change", () => {
        const values = [...this.state.settings[direction]] as [
          SwipeActionId,
          SwipeActionId
        ]
        values[stage] = select.value as SwipeActionId
        this.actions.update({ [direction]: values })
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

  private installHandle(
    handle: HTMLButtonElement,
    direction: Direction,
    stage: StageIndex
  ): void {
    const setFromClientX = (clientX: number): void => {
      const box = this.track.getBoundingClientRect()
      const displayed =
        direction === "right" ? clientX - box.left : box.right - clientX
      this.setThreshold(
        stage,
        Math.round(displayed / this.presentationScale(box.width))
      )
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
      const current = this.state.settings.stages[stage].threshold
      const step = event.shiftKey ? 10 : 1
      let next: number | undefined
      if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
        next = current - step
      } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
        next = current + step
      } else if (event.key === "Home") {
        next = stage === 0
          ? MIN_THRESHOLD
          : this.state.settings.stages[0].threshold + MIN_STAGE_GAP
      } else if (event.key === "End") {
        next = Math.round(
          this.track.clientWidth / 2 / this.presentationScale()
        )
      }
      if (next === undefined) return
      event.preventDefault()
      this.setThreshold(stage, next)
    })
  }

  private setThreshold(stage: StageIndex, raw: number): void {
    const stages = this.state.settings.stages.map((value) => ({ ...value })) as
      SwipeSettings["stages"]
    const maximum = Math.round(
      this.track.clientWidth / 2 / this.presentationScale()
    )
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
    this.actions.update({ stages })
  }

  update(state: SwipeSettingsLabViewState): void {
    this.state = state
    this.render()
  }


  private render(): void {
    const current = this.state.settings
    this.undoSnackbar.checked = current.undoSnackbarEnabled
    this.undoSnackbarDuration.value = String(current.undoSnackbarDurationMs)
    this.undoSnackbarDurationOutput.value =
      `${current.undoSnackbarDurationMs / 1000} s`
    this.undoSnackbarDuration.disabled = !current.undoSnackbarEnabled
    this.undoSnackbarDuration.closest("p")?.classList.toggle(
      "disabled",
      !current.undoSnackbarEnabled
    )
    this.twoStage.checked = current.twoStage
    this.sticky.checked = current.stickyStages
    this.stickyStrength.value = String(current.stickyStrength)
    this.stickyOutput.value = String(current.stickyStrength)
    this.fastMode.checked = current.fastSwipeMode
    this.lockIn.value = String(current.stage2LockInMs)
    this.lockOutput.value = `${current.stage2LockInMs} ms`
    this.stickyStrength.disabled = !current.stickyStages
    this.stickyStrength.closest("p")?.classList.toggle(
      "disabled",
      !current.stickyStages
    )
    this.fastMode.disabled = !current.twoStage
    this.fastMode.closest("p")?.classList.toggle(
      "disabled",
      !current.twoStage
    )
    this.lockIn.disabled =
      !current.twoStage || !current.fastSwipeMode
    this.lockIn.closest("p")?.classList.toggle("disabled", this.lockIn.disabled)
    for (const direction of ["right", "left"] as const) {
      for (const stage of [0, 1] as const) {
        const select = this.selects.get(`${direction}-${stage}`)
        if (!select) continue
        syncSwipeActionOptions(select,current[direction][stage])
        select.value = current[direction][stage]
        select.disabled = stage === 1 && !current.twoStage
        select.dataset.action = select.value
        const field = select.closest<HTMLLabelElement>("label")
        field?.classList.toggle("disabled", select.disabled)
        if (field) field.dataset.action = select.value
      }
    }
    // Desktop keeps exact 1px-per-pixel ruler geometry. Mobile scales the
    // presentation when necessary so its settings never require horizontal
    // scrolling; the saved thresholds remain real gesture distances.
    this.syncInnerMinWidth()
    this.renderStatus()
    requestAnimationFrame(() => this.layout())
  }

  private renderStatus(): void {
    if (this.state.status === "failed") {
      this.status.textContent = "Could not save — edit to retry"
    } else if (this.state.status === "saving") {
      this.status.textContent = "Saving…"
    } else {
      this.status.textContent = "Saved"
    }
    this.undo.disabled = !this.state.canUndo
  }

  private layout(): void {
    this.syncInnerMinWidth()
    const width = this.track.clientWidth
    if (!width) return
    const half = Math.round(width / 2)
    const current = this.state.settings
    const [first, second] = current.stages.map((stage) => stage.threshold)
    const scale = this.presentationScale(width)
    const firstPosition = first * scale
    const scaledSecond = second * scale
    // On an odd-width ruler, mirroring the rounded maximum puts the two
    // stage-2 handles one pixel apart (for example 252px and 251px in 503px).
    // Once stage 2 reaches that maximum, give both sides the same geometric
    // centre so the handles and zone seam paint on precisely the same pixel.
    const secondPosition = scaledSecond >= half ? width / 2 : scaledSecond
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
      const text = swipeActionLabel(action)
      const label = node.querySelector<HTMLElement>(".swipe_ruler_zone_label")
      if (!label) return
      label.textContent = text
      const room = node.clientWidth - 2 * (this.handleWidth() + 4)
      if (this.textWidth(label, text) + 4 > room) {
        label.textContent = ""
      }
    }
    zone("right-dead", 0, firstPosition, "none")
    zone(
      "right-2",
      current.twoStage ? secondPosition : half,
      half,
      current.right[1],
      !current.twoStage
    )
    zone(
      "right-1",
      firstPosition,
      current.twoStage ? secondPosition : half,
      current.right[0]
    )
    zone(
      "left-2",
      half,
      current.twoStage ? width - secondPosition : half,
      current.left[1],
      !current.twoStage
    )
    zone("left-dead", width - firstPosition, width, "none")
    zone(
      "left-1",
      width - (current.twoStage ? secondPosition : half),
      width - firstPosition,
      current.left[0]
    )

    for (const direction of ["right", "left"] as const) {
      for (const stage of [0, 1] as const) {
        const handle = this.handles.get(`${direction}-${stage}`)
        if (!handle) continue
        const threshold = current.stages[stage].threshold
        const position = stage === 1 ? secondPosition : threshold * scale
        const x = direction === "right" ? position : width - position
        handle.style.left = `${Math.round(x)}px`
        handle.classList.toggle(
          "disabled",
          stage === 1 && !current.twoStage
        )
        handle.disabled = stage === 1 && !current.twoStage
        handle.setAttribute("aria-valuemin", String(
          stage === 0 ? MIN_THRESHOLD : first + MIN_STAGE_GAP
        ))
        handle.setAttribute("aria-valuemax", String(Math.round(half / scale)))
        handle.setAttribute("aria-valuenow", String(threshold))
        const value = handle.querySelector<HTMLElement>(".swipe_ruler_value")
        if (value) {
          value.textContent =
            stage === 1 && !current.twoStage ? "" : `${threshold}px`
        }
      }
    }
    const markerX = this.travel >= 0
      ? this.travel * scale
      : width + this.travel * scale
    this.marker.style.left = `${Math.round(markerX)}px`
    this.marker.classList.toggle("active", this.travel !== 0)
  }

  private measureContext?: CanvasRenderingContext2D | null

  private syncInnerMinWidth(): void {
    const required = this.state.settings.stages[1].threshold * 2
    const available = this.scroller.clientWidth
    // An odd-width ruler can leave a previously saved midpoint one pixel
    // wider than its viewport. Treat that rounding residue as a fit so it
    // cannot create document overflow or revive the horizontal scrollbar.
    const minWidth =
      document.body.dataset.platform === "mobile" ||
      (available > 0 && required <= available + 1)
        ? "100%"
        : `${required}px`
    if (this.inner.style.minWidth !== minWidth) {
      this.inner.style.minWidth = minWidth
    }
  }

  private presentationScale(width = this.track.clientWidth): number {
    if (document.body.dataset.platform !== "mobile") return 1
    const required = this.state.settings.stages[1].threshold * 2
    return required > 0 ? Math.min(1, width / required) : 1
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
