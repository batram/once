import { SourceError } from "@once/app"
import { resolveStorySource, isResolved, StoryParser } from "@once/collectors"
import { StorySource } from "@once/core"
import { AnchoredMenuItem } from "../../menu/storyAnchoredMenu"
import {
  createActionButton,
  createRowBody,
  createRowChevron
} from "./form"
import { SourceGroup } from "./sourceGroups"

function asSource(source: StorySource | string): StorySource {
  return typeof source === "string" ? { id: `src_test${"0".repeat(8)}`, url: source } : source
}

function collectorFor(source: StorySource | string): StoryParser | undefined {
  const resolved = resolveStorySource(asSource(source))
  return isResolved(resolved) ? resolved.collector : undefined
}

function sourceLabel(sourceValue: StorySource | string): string {
  const source = asSource(sourceValue)
  if (source.label) return source.label
  try {
    return new URL(source.url).hostname
  } catch {
    return source.url.length > 42 ? `${source.url.slice(0, 39)}…` : source.url
  }
}

export function sourceDragPosition(
  transfer: DataTransfer | null
): [number, number] | null {
  const match = transfer?.getData("text/plain").match(/^(\d+):(\d+)$/)
  return match ? [Number(match[1]), Number(match[2])] : null
}

export interface SourceRowHost {
  groups: SourceGroup[]
  errors: Map<string, SourceError>
  onTouch(): boolean
  edit(root: HTMLElement, groupIndex?: number, sourceIndex?: number): void
  save(reloadStories?: boolean): void
  /** Refetches one source now, ignoring its cache window. */
  reload(sourceId: string): void
  showError(source: string): void
  openMenu(anchor: HTMLElement, items: AnchoredMenuItem[]): void
}

export function clearSourceDropTargets(root: HTMLElement): void {
  root.querySelectorAll(
    ".structured_source_drop_before, .structured_source_drop_after"
  ).forEach((target) => target.classList.remove(
    "structured_source_drop_before",
    "structured_source_drop_after"
  ))
  root.querySelectorAll(
    ".structured_source_group_drop_target," +
    " .structured_source_group_title_drop_target"
  ).forEach((target) => target.classList.remove(
    "structured_source_group_drop_target",
    "structured_source_group_title_drop_target"
  ))
}

export function updateSourceDropTarget(
  root: HTMLElement,
  dragged: HTMLElement,
  clientY: number
): void {
  if (clientY <= 0) return
  clearSourceDropTargets(root)
  const groups = Array.from(
    root.querySelectorAll<HTMLElement>(".structured_group")
  ).filter((group) => group.offsetParent !== null)
  if (!groups.length) return
  // Resolve gaps to the nearest group. Native Android drag events commonly
  // report the list container rather than the row under the finger.
  const group = groups.find((candidate) => {
    const bounds = candidate.getBoundingClientRect()
    return clientY >= bounds.top && clientY <= bounds.bottom
  }) || groups.reduce((nearest, candidate) => {
    const distance = (element: HTMLElement) => {
      const bounds = element.getBoundingClientRect()
      return Math.min(
        Math.abs(clientY - bounds.top),
        Math.abs(clientY - bounds.bottom)
      )
    }
    return distance(candidate) < distance(nearest) ? candidate : nearest
  })
  const list = group.querySelector<HTMLElement>(".structured_rows")
  if (!list || list.offsetParent === null) {
    group.classList.add("structured_source_group_title_drop_target")
    return
  }
  const rows = Array.from(list.querySelectorAll<HTMLElement>(".structured_row"))
    .filter((row) => row !== dragged && row.offsetParent !== null)
  if (!rows.length) {
    // A group containing only the dragged row has no alternative insertion
    // point. Showing its append marker suggests a move that cannot occur.
    if (!group.contains(dragged)) {
      list.classList.add("structured_source_group_drop_target")
    }
    return
  }
  const target = rows.find((row) => {
    const bounds = row.getBoundingClientRect()
    return clientY >= bounds.top && clientY <= bounds.bottom
  }) || rows.reduce((nearest, row) => {
    const distance = (element: HTMLElement) => {
      const bounds = element.getBoundingClientRect()
      return Math.min(
        Math.abs(clientY - bounds.top),
        Math.abs(clientY - bounds.bottom)
      )
    }
    return distance(row) < distance(nearest) ? row : nearest
  })
  const bounds = target.getBoundingClientRect()
  target.classList.add(clientY >= bounds.top + bounds.height / 2
    ? "structured_source_drop_after"
    : "structured_source_drop_before")
}

function installRowDrag(
  row: HTMLElement,
  root: HTMLElement,
  host: SourceRowHost,
  groupIndex: number,
  sourceIndex: number
): void {
  row.addEventListener("dragstart", (event) => {
    row.classList.add("structured_row_dragging")
    event.dataTransfer?.setData("text/plain", `${groupIndex}:${sourceIndex}`)
  })
  row.addEventListener("drag", (event) =>
    updateSourceDropTarget(root, row, event.clientY))
  row.addEventListener("dragend", () => {
    row.classList.remove("structured_row_dragging")
    clearSourceDropTargets(root)
  })
  row.addEventListener("dragover", (event) => {
    if (!sourceDragPosition(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    clearSourceDropTargets(root)
    const bounds = row.getBoundingClientRect()
    row.classList.add(event.clientY >= bounds.top + bounds.height / 2
      ? "structured_source_drop_after"
      : "structured_source_drop_before")
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move"
  })
  row.addEventListener("dragleave", (event) => {
    const next = event.relatedTarget
    if (next instanceof Node && row.contains(next)) return
    row.classList.remove(
      "structured_source_drop_before",
      "structured_source_drop_after"
    )
  })
  row.addEventListener("drop", (event) => {
    event.preventDefault()
    event.stopPropagation()
    const position = sourceDragPosition(event.dataTransfer)
    if (!position) return
    const after = event.clientY >=
      row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2
    const [fromGroup, fromIndex] = position
    const origin = host.groups[fromGroup]
    const target = host.groups[groupIndex]
    if (!origin || !target || fromIndex < 0 ||
        fromIndex >= origin.sources.length) return
    const [value] = origin.sources.splice(fromIndex, 1)
    let destination = sourceIndex + (after ? 1 : 0)
    if (fromGroup === groupIndex && fromIndex < sourceIndex) destination--
    target.sources.splice(destination, 0, value)
    clearSourceDropTargets(root)
    host.save(false)
  })
}

function appendRowActions(
  body: HTMLElement,
  row: HTMLElement,
  root: HTMLElement,
  host: SourceRowHost,
  sourceValue: StorySource | string,
  groupIndex: number,
  sourceIndex: number
): void {
  const source = asSource(sourceValue)
  const edit = () => host.edit(root, groupIndex, sourceIndex)
  body.append(createRowChevron(`Edit ${source.url}`, edit))
  if (host.onTouch()) return
  const menu = document.createElement("button")
  menu.type = "button"
  menu.className = "structured_row_menu"
  menu.textContent = "⋮"
  menu.title = `Actions for ${source.url}`
  menu.setAttribute("aria-label", menu.title)
  const open = () => host.openMenu(menu, [
    { id: "edit-source", label: "Edit source", select: edit },
    {
      id: "reload-source",
      label: "Reload source",
      select: () => host.reload(source.id)
    },
    {
      id: "delete-source",
      label: "Delete source",
      select: () => {
        if (!window.confirm("Delete this story source?")) return
        host.groups[groupIndex].sources.splice(sourceIndex, 1)
        host.save()
      }
    }
  ])
  menu.addEventListener("click", open)
  row.addEventListener("contextmenu", (event) => {
    event.preventDefault()
    open()
  })
  body.append(menu)
}

export function renderSourceRow(
  root: HTMLElement,
  host: SourceRowHost,
  sourceValue: StorySource | string,
  groupIndex: number,
  sourceIndex: number
): HTMLElement {
  const source = asSource(sourceValue)
  const row = document.createElement("div")
  row.className = "structured_row"
  row.draggable = true
  row.dataset.rowKey = source.id
  row.dataset.groupIndex = String(groupIndex)
  row.dataset.sourceIndex = String(sourceIndex)
  const parser = collectorFor(source)
  row.dataset.searchValue = [source.id, source.url, sourceLabel(source), parser?.options.type]
    .filter(Boolean).join(" ").toLowerCase()
  const badge = document.createElement("span")
  badge.className = "collector_badge"
  badge.textContent = parser?.options.type || "?"
  badge.dataset.searchText = badge.textContent
  badge.title = parser?.options.description || "Unknown collector"
  if (parser?.options.colors?.[0]) {
    badge.style.setProperty("--source-badge-bg", parser.options.colors[0])
    badge.style.setProperty("--source-badge-color", parser.options.colors[1])
  }
  const handle = document.createElement("span")
  handle.className = "structured_source_drag_handle"
  handle.setAttribute("aria-hidden", "true")
  const open = document.createElement("button")
  open.type = "button"
  open.className = "structured_row_main"
  open.dataset.sourceId = source.id
  open.dataset.testid = "source-row"
  open.title = source.url
  open.setAttribute("aria-label", `Edit ${source.url}`)
  const primary = document.createElement("span")
  primary.className = "structured_row_primary"
  primary.textContent = sourceLabel(source)
  primary.dataset.searchText = primary.textContent
  const secondary = document.createElement("span")
  secondary.className = "structured_row_secondary"
  const error = host.errors.get(source.id)
  secondary.textContent = error ? error.title || error.message : source.url
  secondary.dataset.searchText = secondary.textContent
  if (error) secondary.classList.add("structured_row_secondary_error")
  open.append(primary, secondary)
  open.addEventListener("click", () => host.edit(root, groupIndex, sourceIndex))
  const body = createRowBody(open)
  if (error) {
    row.classList.add(`structured_row_${error.type}`)
    const issue = createActionButton(
      error.type === "warning" ? "⚠" : "!",
      () => host.showError(source.id),
      "source-error"
    )
    issue.className = `structured_issue ${error.type}`
    issue.title = `Open ${error.type} details`
    body.append(issue)
  }
  appendRowActions(body, row, root, host, source, groupIndex, sourceIndex)
  row.append(handle, badge, body)
  row.classList.toggle("structured_row_disabled", source.enabled === false)
  installRowDrag(row, root, host, groupIndex, sourceIndex)
  return row
}
