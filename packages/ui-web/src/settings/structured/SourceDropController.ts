import {
  clearSourceDropTargets,
  SourceRowHost,
  sourceDragPosition,
  updateSourceDropTarget
} from "./sourceRows"

/**
 * Owns source-row drop targeting and model updates. Group reordering remains
 * in SourceGroupView; the callback prevents the two drag gestures competing.
 */
export class SourceDropController {
  constructor(
    private host: SourceRowHost,
    private groupDragActive: () => boolean
  ) {}

  installList(list: HTMLElement, groupIndex: number): void {
    list.addEventListener("dragover", (event) => {
      if (!sourceDragPosition(event.dataTransfer)) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move"
      const root = list.closest<HTMLElement>(".structured_settings")
      const dragged = root?.querySelector<HTMLElement>(
        ".structured_row_dragging"
      )
      if (root && dragged) {
        updateSourceDropTarget(root, dragged, event.clientY)
      } else {
        clearSourceDropTargets(list.parentElement || list)
        list.classList.add("structured_source_group_drop_target")
      }
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
      const indicated = list.querySelector<HTMLElement>(
        ".structured_source_drop_before, .structured_source_drop_after"
      )
      const sourceIndex = Number(indicated?.dataset.sourceIndex)
      const after = indicated?.classList.contains(
        "structured_source_drop_after"
      )
      clearSourceDropTargets(
        list.closest<HTMLElement>(".structured_settings") || list
      )
      this.move(
        position,
        groupIndex,
        Number.isInteger(sourceIndex) ? sourceIndex + (after ? 1 : 0) : undefined
      )
    })
  }

  /**
   * A group title accepts source drops so collapsed and empty groups remain
   * reachable. An active group reorder always wins over this source gesture.
   */
  installTitle(
    root: HTMLElement,
    summary: HTMLElement,
    details: HTMLElement,
    groupIndex: number
  ): void {
    summary.addEventListener("dragover", (event) => {
      if (this.groupDragActive() ||
          !sourceDragPosition(event.dataTransfer)) return
      event.preventDefault()
      event.stopPropagation()
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move"
      clearSourceDropTargets(root)
      details.classList.add("structured_source_group_title_drop_target")
    })
    summary.addEventListener("dragleave", (event) => {
      const next = event.relatedTarget
      if (!(next instanceof Node && summary.contains(next))) {
        details.classList.remove("structured_source_group_title_drop_target")
      }
    })
    summary.addEventListener("drop", (event) => {
      if (this.groupDragActive()) return
      const position = sourceDragPosition(event.dataTransfer)
      if (!position) return
      event.preventDefault()
      event.stopPropagation()
      details.classList.remove("structured_source_group_title_drop_target")
      this.move(position, groupIndex)
      root.classList.remove("structured_group_drag_active")
    })
  }

  private move(
    position: [number, number],
    destination: number,
    destinationIndex?: number
  ): void {
    const [fromGroup, fromIndex] = position
    const origin = this.host.groups[fromGroup]
    const target = this.host.groups[destination]
    if (!origin || !target || fromIndex < 0 || fromIndex >= origin.sources.length) {
      return
    }
    const [value] = origin.sources.splice(fromIndex, 1)
    let index = destinationIndex ?? target.sources.length
    if (fromGroup === destination && fromIndex < index) index--
    target.sources.splice(Math.max(0, Math.min(index, target.sources.length)), 0,
      value)
    this.host.save(false)
  }
}
