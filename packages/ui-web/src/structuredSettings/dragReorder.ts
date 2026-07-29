/**
 * Drag-to-reorder for a flat row list. The drop reads the indicator the last
 * dragover left so the visible insertion line is the committed position.
 */
export function installRowDragReorder(
  rows: HTMLElement,
  row: HTMLElement,
  index: number,
  reorder: (from: number, destination: number) => void
): void {
  const clearTargets = (keep?: HTMLElement) => {
    rows.querySelectorAll(".structured_row_drop_target").forEach((target) => {
      if (target === keep) return
      target.classList.remove(
        "structured_row_drop_target",
        "structured_row_drop_after"
      )
    })
  }
  const markTarget = (event: DragEvent) => {
    const bounds = row.getBoundingClientRect()
    clearTargets(row)
    row.classList.add("structured_row_drop_target")
    row.classList.toggle(
      "structured_row_drop_after",
      event.clientY >= bounds.top + bounds.height / 2
    )
  }
  row.addEventListener("dragstart", (event) => {
    row.classList.add("structured_row_dragging")
    event.dataTransfer?.setData("text/plain", String(index))
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move"
  })
  row.addEventListener("dragend", () => {
    row.classList.remove("structured_row_dragging")
    clearTargets()
  })
  row.addEventListener("dragenter", (event) => {
    event.preventDefault()
    markTarget(event)
  })
  row.addEventListener("dragleave", (event) => {
    const next = event.relatedTarget
    if (next instanceof Node && (row.contains(next) || rows.contains(next))) {
      return
    }
    row.classList.remove(
      "structured_row_drop_target",
      "structured_row_drop_after"
    )
  })
  row.addEventListener("dragover", (event) => {
    event.preventDefault()
    markTarget(event)
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move"
  })
  row.addEventListener("drop", (event) => {
    event.preventDefault()
    event.stopPropagation()
    const after = row.classList.contains("structured_row_drop_after")
    row.classList.remove(
      "structured_row_drop_target",
      "structured_row_drop_after"
    )
    const from = Number(event.dataTransfer?.getData("text/plain"))
    if (!Number.isInteger(from) || from < 0) return
    let destination = index + (after ? 1 : 0)
    if (from < destination) destination--
    if (from === destination) return
    reorder(from, destination)
  })
}

/** Keeps native HTML drags moving when the pointer reaches a visible edge. */
export function installDragAutoScroll(root: HTMLElement): void {
  const state = { frame: null as number | null, velocity: 0 }
  let scroller: HTMLElement = root
  const scrollContainer = () => {
    const overflow = getComputedStyle(root).overflowY
    if ((overflow === "auto" || overflow === "scroll") &&
        root.scrollHeight > root.clientHeight) {
      return root
    }
    return root.closest<HTMLElement>(".settings_section") || root
  }
  const stop = () => {
    state.velocity = 0
    if (state.frame !== null) cancelAnimationFrame(state.frame)
    state.frame = null
  }
  const step = () => {
    if (state.velocity === 0) {
      state.frame = null
      return
    }
    const previous = scroller.scrollTop
    scroller.scrollTop += state.velocity
    if (scroller.scrollTop === previous) {
      stop()
      return
    }
    state.frame = requestAnimationFrame(step)
  }
  const section = root.closest<HTMLElement>(".settings_section")
  const update = (event: DragEvent) => {
    if (!event.dataTransfer) return
    if (event.currentTarget === section &&
        event.target instanceof Node &&
        root.contains(event.target)) {
      return
    }
    event.preventDefault()
    scroller = scrollContainer()
    const bounds = scroller.getBoundingClientRect()
    const searchBounds = root.querySelector<HTMLElement>(
      ".structured_search"
    )?.getBoundingClientRect()
    const visibleTop = Math.max(
      bounds.top,
      searchBounds && searchBounds.bottom <= bounds.bottom
        ? searchBounds.bottom
        : bounds.top
    )
    const visibleHeight = Math.max(1, bounds.bottom - visibleTop)
    const edge = Math.min(128, Math.max(72, visibleHeight * 0.24))
    const distanceFromTop = event.clientY - visibleTop
    const distanceFromBottom = bounds.bottom - event.clientY
    let velocity = 0
    if (distanceFromTop < edge) {
      const intensity = Math.min(1, Math.max(0, 1 - distanceFromTop / edge))
      velocity = -Math.max(3, Math.round(22 * intensity))
    } else if (distanceFromBottom < edge) {
      const intensity = Math.min(1, Math.max(0, 1 - distanceFromBottom / edge))
      velocity = Math.max(3, Math.round(22 * intensity))
    }
    state.velocity = velocity
    if (velocity === 0) {
      stop()
    } else {
      scroller.scrollTop += velocity
      if (state.frame === null) state.frame = requestAnimationFrame(step)
    }
  }
  root.addEventListener("dragover", update)
  if (section && section !== root) section.addEventListener("dragover", update)
  root.addEventListener("dragleave", (event) => {
    const next = event.relatedTarget
    if (next instanceof Node &&
        (root.contains(next) || section?.contains(next))) return
    stop()
  })
  const eventRoot = section || root
  eventRoot.addEventListener("drop", stop)
  eventRoot.addEventListener("dragend", stop)
}
