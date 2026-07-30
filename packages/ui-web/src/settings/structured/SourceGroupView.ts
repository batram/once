import { createActionButton } from "./form"
import {
  renderSourceRow,
  SourceRowHost,
  sourceDragPosition
} from "./sourceRows"
import { SourceGroup } from "./sourceGroups"

export interface SourceGroupHost extends SourceRowHost {
  listActions(): HTMLElement | null
  editGroup(root: HTMLElement, groupIndex?: number): void
  deleteGroup(root: HTMLElement, groupIndex: number): void
}

/**
 * State of one group reorder gesture, shared by the pointer, touch, and
 * native drag-and-drop paths so at most one reorder can be in flight.
 *
 * `index` is the authoritative "a reorder is running" flag: source-row drop
 * handlers refuse to move a row while it is set, and `beginDrag` refuses a
 * second gesture. `destination` is already expressed in post-removal
 * coordinates, so `commitDrop` can splice with it directly. `committed` is a
 * commit-once latch, because a gesture can end at a `drop` handler or at
 * `dragend` and both may fire. `expanded` and `collapseFrame` belong to the
 * cosmetic collapse described on `beginDrag`, and `suppressToggle` protects
 * the user's expansion choices from that collapse.
 */
interface DragState {
  index: number | null; destination: number | null; committed: boolean
  expanded: Map<string, boolean> | null; collapseFrame: number | null
  suppressToggle: boolean
}

export class SourceGroupView {
  /**
   * A render replaces the group elements but cannot unbind the listeners of
   * the elements it replaced, and `host.save()` re-renders synchronously.
   * Each `toggle` listener captures the generation it was rendered in, so a
   * queued event from a replaced element cannot write a stale expansion state
   * into `open`.
   */
  private generation = 0
  // Labels rendered rows as `data-row-key`; no caller reads it yet.
  private rowSequence = 0
  /**
   * Expansion state by group id, not by index: group order changes under a
   * reorder, and `SourceSettingsEditor.read` carries ids across a reparse so a
   * group the user opened stays open when the text is saved and read back.
   * Groups absent from the map default to open.
   */
  private open = new Map<string, boolean>()
  private drag: DragState = { index: null, destination: null, committed: false,
    expanded: null, collapseFrame: null, suppressToggle: false }

  constructor(private host: SourceGroupHost) {}
  expand(groupId: string): void { this.open.set(groupId, true) }

  render(root: HTMLElement): void {
    const generation = ++this.generation
    if (!this.host.onTouch()) {
      this.host.listActions()?.append(
        createActionButton(
          "Add source",
          () => this.host.edit(root),
          "add-source"
        ),
        createActionButton(
          "Add group",
          () => this.host.editGroup(root),
          "add-source-group"
        )
      )
    }
    this.renderStatus(root)
    this.installRootDrop(root)
    this.host.groups.forEach((group, index) =>
      root.append(this.renderGroup(root, group, index, generation)))
  }

  private renderStatus(root: HTMLElement): void {
    const count = this.host.groups.reduce(
      (total, group) => total + group.sources.length,
      0
    )
    const failing = this.host.groups.reduce((total, group) =>
      total + group.sources.filter(
        (source) => this.host.errors.has(source.trim())
      ).length, 0)
    const status = root.parentElement?.querySelector<HTMLElement>(
      ".structured_status_counts"
    )
    if (!status) return
    status.textContent =
      `${count} ${count === 1 ? "source" : "sources"} · ` +
      `${this.host.groups.length} ` +
      `${this.host.groups.length === 1 ? "group" : "groups"}`
    if (!failing) return
    const issue = document.createElement("span")
    issue.className = "structured_status_error"
    issue.textContent = ` ${failing} failing`
    status.append(issue)
  }

  private renderGroup(
    root: HTMLElement,
    group: SourceGroup,
    index: number,
    generation: number
  ): HTMLDetailsElement {
    // Group 0 is the implicit ungrouped bucket: it cannot be renamed, deleted,
    // dragged, or displaced, which is why index 0 is special-cased throughout.
    const details = document.createElement("details")
    details.className = "structured_group"
    if (index > 0) details.classList.add("structured_group_reorderable")
    details.open = this.open.get(group.id) ?? true
    details.dataset.groupIndex = String(index)
    details.dataset.groupId = group.id
    details.dataset.searchValue = group.name.toLowerCase()
    // Only a toggle the user caused counts as a preference: the reorder
    // collapse and its restoration also mutate `open` on the element, and
    // `toggle` is delivered after the fact.
    details.addEventListener("toggle", () => {
      if (!this.drag.suppressToggle && generation === this.generation) {
        this.open.set(group.id, details.open)
      }
    })
    const summary = this.renderSummary(root, details, group, index)
    details.append(summary, this.renderRows(root, group, index))
    this.installGroupDrag(root, details, summary, group, index)
    if (this.host.onTouch() && index > 0) {
      this.installTouchReorder(root, details, summary, group, index)
    }
    return details
  }

  private renderSummary(
    root: HTMLElement,
    details: HTMLDetailsElement,
    group: SourceGroup,
    index: number
  ): HTMLElement {
    const summary = document.createElement("summary")
    const caret = document.createElement("span")
    caret.className = "structured_group_caret"
    caret.setAttribute("aria-hidden", "true")
    const handle = document.createElement("span")
    handle.className = "structured_group_drag_handle"
    handle.setAttribute("aria-hidden", "true")
    const name = document.createElement("strong")
    name.className = "structured_group_name"
    name.textContent = group.name
    name.dataset.searchText = group.name
    name.draggable = index > 0
    if (index > 0) {
      name.title = `Drag to reorder ${group.name}`
      name.setAttribute("aria-label", `${group.name} group; drag to reorder`)
    }
    const count = document.createElement("span")
    count.className = "structured_group_count"
    count.textContent = String(group.sources.length)
    summary.append(caret)
    if (index > 0) summary.append(handle)
    summary.append(name, count)
    this.appendGroupActions(root, summary, group, index)
    this.installSourceTitleDrop(root, summary, details, index)
    return summary
  }

  private appendGroupActions(
    root: HTMLElement,
    summary: HTMLElement,
    group: SourceGroup,
    index: number
  ): void {
    if (index === 0) {
      const spacer = document.createElement("span")
      spacer.className = "structured_group_menu_spacer"
      spacer.setAttribute("aria-hidden", "true")
      summary.append(spacer)
      return
    }
    const controls = document.createElement("span")
    controls.className = "structured_group_actions"
    controls.addEventListener("click", (event) => event.preventDefault())
    const menu = document.createElement("button")
    menu.type = "button"
    menu.className = "structured_group_menu"
    menu.textContent = "⋮"
    menu.title = `${group.name} group actions`
    menu.setAttribute("aria-label", menu.title)
    menu.addEventListener("click", () => this.host.openMenu(menu, [
      {
        id: "rename-group",
        label: "Rename group",
        testid: "rename-source-group",
        select: () => this.host.editGroup(root, index)
      },
      {
        id: "delete-group",
        label: "Delete group",
        testid: "delete-source-group",
        select: () => this.host.deleteGroup(root, index)
      },
      {
        id: "add-source-here",
        label: "Add source here",
        testid: this.host.onTouch() ? "add-source-group" : "add-source-here",
        select: () => this.host.edit(root, index)
      }
    ]))
    controls.append(menu)
    summary.append(controls)
  }

  private renderRows(
    root: HTMLElement,
    group: SourceGroup,
    groupIndex: number
  ): HTMLElement {
    const list = document.createElement("div")
    list.className = "structured_rows"
    this.installSourceListDrop(list, groupIndex)
    group.sources.forEach((source, sourceIndex) => {
      list.append(renderSourceRow(
        root,
        this.host,
        source,
        groupIndex,
        sourceIndex,
        `source-${++this.rowSequence}`
      ))
    })
    if (!group.sources.length) {
      const empty = document.createElement("p")
      empty.className = "structured_empty"
      empty.textContent = "No sources"
      list.append(empty)
    }
    return list
  }

  // A row list accepts only a source payload — `<group>:<source>` indices in
  // `text/plain` — so a group drag crossing it never lights up as a target.
  private installSourceListDrop(list: HTMLElement, groupIndex: number): void {
    list.addEventListener("dragover", (event) => {
      if (!sourceDragPosition(event.dataTransfer)) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move"
      list.classList.add("structured_source_group_drop_target")
    })
    list.addEventListener("dragleave", (event) => {
      const next = event.relatedTarget
      if (!(next instanceof Node && list.contains(next))) {
        list.classList.remove("structured_source_group_drop_target")
      }
    })
    list.addEventListener("drop", (event) => {
      const position = sourceDragPosition(event.dataTransfer)
      if (!position) return
      event.preventDefault()
      event.stopPropagation()
      list.classList.remove("structured_source_group_drop_target")
      this.moveSource(position, groupIndex)
    })
  }

  /**
   * Dropping a source on a group title moves it into that group, which is the
   * only way to reach a collapsed or empty group. The `drag.index` checks make
   * the group reorder win: while a group is being dragged its own summary is
   * under the pointer, and treating that as a source drop would move a row.
   */
  private installSourceTitleDrop(
    root: HTMLElement,
    summary: HTMLElement,
    details: HTMLElement,
    groupIndex: number
  ): void {
    summary.addEventListener("dragover", (event) => {
      if (this.drag.index !== null || !sourceDragPosition(event.dataTransfer)) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move"
      details.classList.add("structured_source_group_title_drop_target")
    })
    summary.addEventListener("dragleave", (event) => {
      const next = event.relatedTarget
      if (!(next instanceof Node && summary.contains(next))) {
        details.classList.remove("structured_source_group_title_drop_target")
      }
    })
    summary.addEventListener("drop", (event) => {
      if (this.drag.index !== null) return
      const position = sourceDragPosition(event.dataTransfer)
      if (!position) return
      event.preventDefault()
      event.stopPropagation()
      details.classList.remove("structured_source_group_title_drop_target")
      this.moveSource(position, groupIndex)
      root.classList.remove("structured_group_drag_active")
    })
  }

  private moveSource(position: [number, number], destination: number): void {
    const [fromGroup, fromIndex] = position
    const origin = this.host.groups[fromGroup]
    const target = this.host.groups[destination]
    // The payload is a stale pair of indices once the model has been edited
    // during the gesture, so it is bounds-checked rather than trusted.
    if (!origin || !target || fromIndex < 0 || fromIndex >= origin.sources.length) {
      return
    }
    const [value] = origin.sources.splice(fromIndex, 1)
    target.sources.push(value)
    this.host.save(false)
  }

  // The list container is the fallback target: gaps between groups and the
  // space below the last group would otherwise cancel an in-flight reorder.
  private installRootDrop(root: HTMLElement): void {
    root.addEventListener("dragover", (event) => {
      if (!this.updateDestinationAt(root, event.clientY)) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move"
    })
    root.addEventListener("drop", (event) => {
      if (this.drag.index === null || this.drag.destination === null) return
      event.preventDefault()
      this.commitDrop(root, this.drag.destination)
    })
  }

  private installGroupDrag(
    root: HTMLElement,
    details: HTMLElement,
    summary: HTMLElement,
    group: SourceGroup,
    index: number
  ): void {
    const name = summary.querySelector<HTMLElement>(".structured_group_name")
    // A drag that starts on the group name still ends in a click on the
    // summary, which `details` would treat as an expand/collapse. The capture
    // listener swallows exactly that click, and the flag is cleared a task
    // later so the click dispatched after `dragend` is still covered.
    let suppressClick = false
    summary.addEventListener("click", (event) => {
      if (!suppressClick) return
      event.preventDefault()
      event.stopPropagation()
    }, { capture: true })
    name?.addEventListener("dragstart", (event) => {
      if (!this.beginDrag(root, details, summary, index)) {
        event.preventDefault()
        return
      }
      suppressClick = true
      event.dataTransfer?.setData("application/x-once-source-group", String(index))
      event.dataTransfer?.setData("text/plain", `group:${index}`)
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move"
    })
    name?.addEventListener("drag", (event) =>
      this.updateDestinationAt(root, event.clientY))
    name?.addEventListener("dragend", (event) => {
      details.classList.remove("structured_group_dragging")
      // Last chance to commit: a drop over a gap, or over a target that did not
      // handle it, reaches only `dragend`. A cancelled drag reports a
      // `dropEffect` of "none" and must leave the order untouched.
      if (!this.drag.committed && this.drag.destination !== null &&
          event.dataTransfer?.dropEffect === "move") {
        this.commitDrop(root, this.drag.destination)
      }
      this.restore(root)
      this.reveal(root, group.id)
      this.drag.destination = null
      window.setTimeout(() => { suppressClick = false }, 0)
    })
    details.addEventListener("dragover", (event) => {
      if (this.drag.index === null) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move"
      this.updateDestination(details, index, event.clientY)
    })
    details.addEventListener("drop", (event) => {
      if (this.drag.index === null) return
      event.preventDefault()
      event.stopPropagation()
      this.updateDestination(details, index, event.clientY)
      if (this.drag.destination !== null) {
        this.commitDrop(root, this.drag.destination)
      }
    })
  }

  /**
   * Opens a reorder gesture, or refuses it for the pinned first group and for
   * a second concurrent gesture.
   *
   * While reordering, `structured_group_drag_active` collapses every group so
   * the whole list is reachable without scrolling. That is presentation only,
   * so the pre-drag expansion of every group is snapshotted first and replayed
   * by `restore`. The collapse waits a frame because it changes layout: the
   * browser must have taken the drag image from the uncollapsed element first,
   * and the scroll position is then corrected by however far the grabbed
   * summary moved, so the group stays under the pointer. The frame is stored so
   * a gesture that ends within it can cancel the collapse instead of undoing
   * it, and it re-checks `drag.index` because a new gesture may own the state
   * by the time it runs.
   */
  private beginDrag(
    root: HTMLElement,
    details: HTMLElement,
    summary: HTMLElement,
    index: number
  ): boolean {
    if (index === 0 || this.drag.index !== null) return false
    this.drag.index = index; this.drag.destination = null
    this.drag.committed = false; this.drag.suppressToggle = true
    this.drag.expanded = new Map(
      Array.from(root.querySelectorAll<HTMLDetailsElement>(".structured_group"))
        .map((entry) => [entry.dataset.groupId || "", entry.open])
    )
    details.classList.add("structured_group_dragging")
    const top = summary.getBoundingClientRect().top
    this.drag.collapseFrame = requestAnimationFrame(() => {
      this.drag.collapseFrame = null
      if (this.drag.index !== index) return
      root.classList.add("structured_group_drag_active")
      const moved = summary.getBoundingClientRect().top - top
      if (moved) root.scrollTop += moved
    })
    return true
  }

  /**
   * Records where the dragged group would land if the gesture ended now, and
   * marks the hovered group with the matching insertion indicator.
   *
   * The pointer is over `index`, and the vertical half decides whether the drop
   * goes before or after it. That insertion point counts positions in the list
   * as it looks now, while `commitDrop` splices the dragged group out before
   * inserting it, so a destination past the origin shifts down by one.
   * Hovering the pinned group resolves to position 1, the earliest a movable
   * group can sit, and the clamp keeps the destination inside the movable range
   * even when the pointer leaves the list.
   */
  private updateDestination(
    details: HTMLElement,
    index: number,
    clientY: number
  ): void {
    if (this.drag.index === null) return
    this.clearTargets(details.closest(".structured_settings") || details)
    const bounds = details.getBoundingClientRect()
    const after = index > 0 && clientY >= bounds.top + bounds.height / 2
    let destination = index === 0 ? 1 : index + (after ? 1 : 0)
    if (this.drag.index < destination) destination--
    this.drag.destination = Math.max(
      1,
      Math.min(destination, this.host.groups.length - 1)
    )
    details.classList.add(after || index === 0
      ? "structured_group_drop_after"
      : "structured_group_drop_before")
  }

  /**
   * Resolves a bare Y coordinate to a group and updates the destination from
   * it, for the events that report a position but no element: the container's
   * `dragover`, the repeated `drag` on the dragged name, and touch movement.
   *
   * A coordinate of 0 or less is the placeholder some browsers report on the
   * final `drag` event, and acting on it would snap the destination to the top
   * of the list. Falling back to the nearest group keeps the gesture live in the
   * gaps between groups and past the ends of the list.
   */
  private updateDestinationAt(root: HTMLElement, clientY: number): boolean {
    if (this.drag.index === null || clientY <= 0) return false
    const groups = Array.from(
      root.querySelectorAll<HTMLElement>(".structured_group")
    )
    if (!groups.length) return false
    const target = groups.find((candidate) => {
      const bounds = candidate.getBoundingClientRect()
      return clientY >= bounds.top && clientY <= bounds.bottom
    }) || groups.reduce((nearest, candidate) =>
      this.distance(candidate, clientY) < this.distance(nearest, clientY)
        ? candidate : nearest)
    const index = Number(target.dataset.groupIndex)
    if (!Number.isInteger(index)) return false
    this.updateDestination(target, index, clientY)
    return true
  }

  private distance(element: HTMLElement, clientY: number): number {
    const bounds = element.getBoundingClientRect()
    return Math.min(
      Math.abs(clientY - bounds.top),
      Math.abs(clientY - bounds.bottom)
    )
  }

  /**
   * Applies the reorder once, and only from the state captured during the
   * gesture — the caller passes the destination because `restore` clears it.
   *
   * The order of the body matters. `restore` runs first, so the expansion state
   * is repaired while the elements it repairs still exist: `host.save` writes
   * the settings text and re-renders synchronously, replacing them. The group is
   * then re-found by id rather than by index, since its index just changed.
   */
  private commitDrop(root: HTMLElement, destination: number): void {
    if (this.drag.committed || this.drag.index === null) return
    this.drag.committed = true
    const from = this.drag.index
    const id = this.host.groups[from].id
    this.restore(root)
    if (destination !== from) {
      const [group] = this.host.groups.splice(from, 1)
      this.host.groups.splice(destination, 0, group)
      this.host.save(false)
    }
    this.reveal(root, id)
  }

  /**
   * Ends the gesture and undoes everything it did for presentation: the pending
   * or applied collapse, the insertion indicators, and the drag-active class.
   *
   * The snapshot is written back to both `open` and the live elements, because
   * a commit re-renders from `open` while a cancelled gesture keeps the elements
   * it collapsed. `suppressToggle` is released a task later, after the `toggle`
   * events caused by those writes have been delivered.
   */
  private restore(root: HTMLElement): void {
    if (this.drag.collapseFrame !== null) {
      cancelAnimationFrame(this.drag.collapseFrame)
    }
    this.drag.collapseFrame = null
    if (this.drag.expanded) {
      for (const [id, open] of this.drag.expanded) this.open.set(id, open)
      root.querySelectorAll<HTMLDetailsElement>(".structured_group")
        .forEach((group) => {
          const id = group.dataset.groupId
          if (id && this.drag.expanded?.has(id)) {
            group.open = this.drag.expanded.get(id) || false
          }
        })
    }
    this.clearTargets(root)
    root.classList.remove("structured_group_drag_active")
    this.drag.index = null; this.drag.expanded = null
    window.setTimeout(() => { this.drag.suppressToggle = false }, 0)
  }

  private clearTargets(root: Element): void {
    root.querySelectorAll(
      ".structured_group_drop_before, .structured_group_drop_after"
    ).forEach((group) => group.classList.remove(
      "structured_group_drop_before",
      "structured_group_drop_after"
    ))
  }

  /**
   * Returns focus to the group the gesture moved, so a keyboard or screen
   * reader user is not dropped at the top of the list.
   *
   * Two frames: the first lets the re-render that `host.save` started replace
   * the elements, the second lets the restored expansion settle so
   * `scrollIntoView` measures the final layout. Focus is taken without
   * scrolling for the same reason.
   */
  private reveal(root: HTMLElement, id: string): void {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const group = root.querySelector<HTMLElement>(
        `[data-group-id="${CSS.escape(id)}"]`
      )
      group?.querySelector<HTMLElement>("summary")
        ?.focus({ preventScroll: true })
      group?.scrollIntoView({ block: "nearest" })
    }))
  }

  /**
   * The touch equivalent of `installGroupDrag`: touch devices get no native
   * drag, so a long press starts the reorder and the group is moved by writing
   * a transform instead of by a drag image.
   *
   * `state` is per element and per gesture. `id` is the pointer or touch
   * identifier the gesture claimed, which keeps a second finger from steering
   * it. `grab` is where inside the group the finger landed, so the group stays
   * under it; `baseTop` is the untransformed top the transform is measured
   * from. `active` separates a pending press from a running reorder, and
   * `timer` is the press that has not yet become one.
   */
  private installTouchReorder(
    root: HTMLElement,
    details: HTMLElement,
    summary: HTMLElement,
    group: SourceGroup,
    index: number
  ): void {
    const state = {
      id: null as number | null,
      startY: 0,
      lastY: 0,
      grab: 0,
      baseTop: 0,
      active: false,
      timer: null as number | null
    }
    const clear = () => {
      if (state.timer !== null) window.clearTimeout(state.timer)
      state.timer = null
      details.classList.remove("structured_group_pressing")
    }
    const activate = () => {
      state.timer = null
      details.classList.remove("structured_group_pressing")
      state.active = this.beginDrag(root, details, summary, index)
      if (!state.active) return
      state.baseTop = details.getBoundingClientRect().top
      this.positionTouch(details, state)
      // `beginDrag` collapses the list a frame later, which moves this group.
      // Re-measure once that has happened, discounting the transform already
      // applied, or every later position would be offset by the collapse.
      requestAnimationFrame(() => {
        if (!state.active) return
        const transform = Number.parseFloat(details.style.getPropertyValue(
          "--structured-group-drag-y"
        )) || 0
        state.baseTop = details.getBoundingClientRect().top - transform
        this.positionTouch(details, state)
      })
      // Seeding from an adjacent group's near edge resolves to this group's own
      // position, so a press that never moves shows an insertion indicator and
      // commits no reorder.
      const neighbor = root.querySelector<HTMLElement>(
        `.structured_group[data-group-index="${index + 1}"]`
      ) || root.querySelector<HTMLElement>(
        `.structured_group[data-group-index="${index - 1}"]`
      )
      if (neighbor) {
        const neighborIndex = Number(neighbor.dataset.groupIndex)
        const bounds = neighbor.getBoundingClientRect()
        this.updateDestination(
          neighbor,
          neighborIndex,
          index < neighborIndex ? bounds.top : bounds.bottom
        )
      }
    }
    // A press on the group's menu button is not a reorder; claiming it would
    // swallow the tap that opens the menu.
    const begin = (id: number, y: number, target: EventTarget | null) => {
      if (target instanceof Element && target.closest(".structured_group_menu")) {
        return
      }
      state.id = id; state.startY = state.lastY = y
      state.grab = y - details.getBoundingClientRect().top; state.active = false
      details.classList.add("structured_group_pressing")
      // Long enough that a scroll or a tap does not trip it, with
      // `structured_group_pressing` as the feedback that the press is being
      // held. Movement before it fires belongs to the scroller.
      state.timer = window.setTimeout(activate, 320)
    }
    const move = (id: number, y: number): boolean => {
      if (id !== state.id) return false
      state.lastY = y
      if (!state.active) {
        // Under the slop the press may still become a reorder, so it stays
        // pending; past it the gesture is a scroll and is abandoned to the
        // scroller, which owns the touch until it is released.
        if (Math.abs(y - state.startY) < 8) return false
        clear()
        state.id = null
        return false
      }
      this.positionTouch(details, state)
      this.updateDestinationAt(root, y)
      return true
    }
    // `touchend` and `pointerup` commit; `touchcancel` and `pointercancel` do
    // not. Either way the transform is dropped and the state is reset, so an
    // interrupted gesture cannot leave the group displaced.
    const finish = (commit: boolean) => {
      if (state.id === null) return
      clear()
      if (state.active && commit && this.drag.destination !== null) {
        this.commitDrop(root, this.drag.destination)
      } else {
        this.restore(root)
        this.reveal(root, group.id)
      }
      details.classList.remove("structured_group_dragging")
      details.style.removeProperty("--structured-group-drag-y")
      state.id = null; state.active = false; this.drag.destination = null
    }
    this.installTouchEvents(summary, begin, move, finish, state)
    this.installPointerEvents(summary, begin, move, finish, state)
  }

  private positionTouch(
    details: HTMLElement,
    state: { lastY: number; grab: number; baseTop: number }
  ): void {
    details.style.setProperty(
      "--structured-group-drag-y",
      `${state.lastY - state.grab - state.baseTop}px`
    )
  }

  private installTouchEvents(
    summary: HTMLElement,
    begin: (id: number, y: number, target: EventTarget | null) => void,
    move: (id: number, y: number) => boolean,
    finish: (commit: boolean) => void,
    state: { id: number | null }
  ): void {
    summary.addEventListener("touchstart", (event) => {
      if (event.touches.length !== 1) return
      const touch = event.changedTouches[0]
      begin(touch.identifier, touch.clientY, event.target)
    }, { passive: true })
    // Not passive: once the reorder is running the page must not scroll under
    // it, and only a non-passive listener may cancel that.
    summary.addEventListener("touchmove", (event) => {
      const touch = Array.from(event.changedTouches)
        .find((entry) => entry.identifier === state.id)
      if (touch && move(touch.identifier, touch.clientY)) event.preventDefault()
    }, { passive: false })
    summary.addEventListener("touchend", (event) => {
      if (Array.from(event.changedTouches)
        .some((entry) => entry.identifier === state.id)) finish(true)
    })
    summary.addEventListener("touchcancel", (event) => {
      if (Array.from(event.changedTouches)
        .some((entry) => entry.identifier === state.id)) finish(false)
    })
  }

  private installPointerEvents(
    summary: HTMLElement,
    begin: (id: number, y: number, target: EventTarget | null) => void,
    move: (id: number, y: number) => boolean,
    finish: (commit: boolean) => void,
    state: { id: number | null }
  ): void {
    // Pens and unknown pointer types only: mouse reordering is the native drag
    // in `installGroupDrag`, and touch is handled by the touch events above, so
    // accepting either here would run two gestures for one input.
    summary.addEventListener("pointerdown", (event) => {
      if (event.pointerType === "mouse" || event.pointerType === "touch" ||
          event.button !== 0) return
      begin(event.pointerId, event.clientY, event.target)
      try {
        summary.setPointerCapture(event.pointerId)
      } catch {
        // Synthetic events and older WebViews may not expose capture.
      }
    })
    summary.addEventListener("pointermove", (event) => {
      if (event.pointerId === state.id && move(event.pointerId, event.clientY)) {
        event.preventDefault()
      }
    })
    summary.addEventListener("pointerup", (event) => {
      if (event.pointerId === state.id) finish(true)
    })
    summary.addEventListener("pointercancel", (event) => {
      if (event.pointerId === state.id) finish(false)
    })
  }
}
