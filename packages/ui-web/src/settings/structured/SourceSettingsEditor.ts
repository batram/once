import { SourceError } from "@once/app"
import { get_active } from "@once/collectors"
import { DEFAULT_GROUP_ID, emptyStorySourceDocument, mintStorySourceGroupId,
  mintStorySourceId, parseStorySourceText, readCacheMinutesInput,
  serializeStorySourceDocument, StorySourceDocument } from "@once/core"
import { showChoiceDialog, showConfirmDialog } from "../../confirmDialog"
import { AnchoredMenuItem } from "../../menu/storyAnchoredMenu"
import { revealElement } from "../../scrollReveal"
import { StructuredFormField } from "./form"
import { SourceGroupView } from "./SourceGroupView"
import { documentFromGroups, groupsFromDocument, SourceGroup } from "./sourceGroups"

export interface SourceSettingsHost {
  onTouch(): boolean; getText(): string; setText(text: string): void
  render(): void; root(): HTMLElement | undefined
  saveSources(value: StorySourceDocument, reloadStories?: boolean): void | Promise<void>
  showSourceError(sourceId: string): void
  openMenu(anchor: HTMLElement, items: AnchoredMenuItem[]): void
  listActions(): HTMLElement | null
  showForm(root: HTMLElement, title: string, fields: StructuredFormField[],
    save: (values: string[]) => boolean,
    remove?: { label: string; action: () => void },
    choices?: Array<[string, string]>): void
}

export class SourceSettingsEditor {
  readonly groups: SourceGroup[] = []
  private document = emptyStorySourceDocument()
  private errors = new Map<string, SourceError>()
  private saveState: "saved" | "saving" | "failed" = "saved"
  private revealSource: string | null = null
  private revealTimer: number | null = null
  private view: SourceGroupView

  constructor(private host: SourceSettingsHost) {
    this.view = new SourceGroupView({ groups: this.groups, errors: this.errors,
      onTouch: () => this.host.onTouch(),
      edit: (root, group, source) => this.editSource(root, group, source),
      editGroup: (root, group) => this.editGroup(root, group),
      deleteGroup: (root, group) => this.deleteGroup(root, group),
      save: (reload) => this.save(reload),
      showError: (id) => this.host.showSourceError(id),
      openMenu: (anchor, items) => this.host.openMenu(anchor, items),
      listActions: () => this.host.listActions() })
  }

  read(text = this.host.getText()): void {
    const parsed = parseStorySourceText(text, this.document)
    if (parsed.ok && parsed.doc) this.setDocument(parsed.doc)
  }
  setDocument(document: StorySourceDocument): void {
    this.document = structuredClone(document)
    this.groups.splice(0, this.groups.length, ...groupsFromDocument(this.document))
  }
  render(root: HTMLElement): void { this.view.render(root); this.renderSaveState(root) }
  setErrors(errors: SourceError[]): void {
    this.errors.clear(); errors.forEach((error) => this.errors.set(error.sourceId, error))
  }
  contains(id: string): boolean { return this.document.sources.some((source) => source.id === id) }
  reveal(id: string): void {
    const source = this.document.sources.find((item) => item.id === id)
    if (!source) return
    this.revealSource = id; this.view.expand(source.groupId ?? DEFAULT_GROUP_ID); this.applyReveal()
  }
  applyReveal(): void {
    const id = this.revealSource; if (!id) return
    if (this.revealTimer !== null) window.clearTimeout(this.revealTimer)
    requestAnimationFrame(() => {
      const target = this.host.root()?.querySelector<HTMLButtonElement>(`[data-source-id="${CSS.escape(id)}"]`)
      const details = target?.closest<HTMLDetailsElement>(".structured_group")
      if (!target || !details || this.revealSource !== id) return
      details.open = true; target.focus({ preventScroll: true })
      revealElement(target, { block: "center" }); target.classList.add("structured_row_target")
      this.revealTimer = window.setTimeout(() => {
        this.revealSource = null; this.revealTimer = null
        target.classList.remove("structured_row_target")
      }, 1600)
    })
  }

  editSource(root: HTMLElement, groupIndex = 0, sourceIndex?: number): void {
    const current = sourceIndex === undefined ? undefined : this.groups[groupIndex].sources[sourceIndex]
    const collectors: Array<[string, string]> = [["", "Auto-detect"],
      ...get_active().map((parser) => [parser.options.id, parser.options.description] as [string, string])]
    const groups = this.groups.map((group) => [group.id, group.name] as [string, string])
    this.host.showForm(root, "Source", [
      // Where the stories come from, then what Once does with them. This order
      // is also the order `values` arrives in below, so Enabled keeps its place
      // here even though the form renders it in the header rather than a row.
      ["URL", current?.url ?? "", { group: "Feed" }],
      ["Label", current?.label ?? "", { optional: true, group: "Feed" }],
      ["Cache minutes", current?.cacheMinutes === undefined ? "" : String(current.cacheMinutes),
        { optional: true, hint: "Blank inherits; 0 always refetches", group: "Feed" }],
      ["Collector", current?.collector ?? "",
        { kind: "select", choices: collectors, optional: true, group: "Handling" }],
      ["Enabled", String(current?.enabled !== false), { kind: "checkbox", optional: true }],
      ["Group", this.groups[groupIndex]?.id ?? DEFAULT_GROUP_ID,
        { kind: "select", choices: groups, group: "Handling" }]
    ], (values) => {
      const [url, label, cacheMinutes, collector, enabled, groupId] = values
      if (!url.trim()) return false
      // Refused rather than clamped or coerced, so a typo cannot quietly
      // become a cache window nobody chose.
      const cacheWindow = readCacheMinutesInput(cacheMinutes)
      if (!cacheWindow.ok) return false
      const source = { ...(current ?? { id: mintStorySourceId(), url: "" }), url: url.trim() }
      if (label.trim()) source.label = label.trim(); else delete source.label
      if (cacheWindow.minutes === undefined) delete source.cacheMinutes
      else source.cacheMinutes = cacheWindow.minutes
      if (collector) source.collector = collector; else delete source.collector
      source.enabled = enabled !== "false"
      if (groupId === DEFAULT_GROUP_ID) delete source.groupId; else source.groupId = groupId
      if (current && sourceIndex !== undefined) {
        this.groups[groupIndex].sources.splice(sourceIndex, 1)
      }
      ;(this.groups.find((group) => group.id === groupId) ?? this.groups[0]).sources.push(source)
      this.save(); return true
    }, current ? { label: "Delete source", action: () => {
      if (window.confirm("Delete this story source?")) {
        if (sourceIndex !== undefined) {
          this.groups[groupIndex].sources.splice(sourceIndex, 1)
        }
        this.save()
      }
    } } : undefined)
  }

  editGroup(root: HTMLElement, groupIndex?: number): void {
    const current = groupIndex === undefined ? "" : this.groups[groupIndex].name
    this.host.showForm(root, "Group", [["Group name", current]], (values) => {
      const name = values[0].trim(); if (!name) return false
      if (groupIndex === undefined) this.groups.push({ id: mintStorySourceGroupId(), name, sources: [] })
      else this.groups[groupIndex].name = name
      this.save(); return true
    })
  }
  async deleteGroup(root: HTMLElement, groupIndex: number): Promise<void> {
    const group = this.groups[groupIndex]
    if (!group.sources.length) {
      if (window.confirm(`Delete group “${group.name}”?`)) { this.groups.splice(groupIndex, 1); this.save() }
      return
    }
    const choice = await showChoiceDialog({ title: `Delete “${group.name}”?`,
      message: "Choose what should happen to the sources in this group.",
      choices: [{ label: "Remove group and move sources to Default", value: "move" },
        { label: "Remove group and its sources", value: "remove" }], positionWithin: root })
    if (choice === "move") this.groups[0].sources.push(...group.sources)
    else if (choice === "remove") {
      if (!await showConfirmDialog({ message: `Permanently delete ${group.sources.length} sources?`,
        confirmLabel: "Delete", positionWithin: root })) return
    } else return
    this.groups.splice(groupIndex, 1); this.save()
  }
  save(reloadStories = true): void {
    this.document = documentFromGroups(this.groups, this.document)
    this.host.setText(serializeStorySourceDocument(this.document))
    this.saveState = "saving"; this.host.render()
    Promise.resolve(this.host.saveSources(this.document, reloadStories)).then(
      () => { this.saveState = "saved"; this.renderSaveState(this.host.root()) },
      () => { this.saveState = "failed"; this.renderSaveState(this.host.root()) })
  }
  private renderSaveState(root?: HTMLElement): void {
    const saved = root?.parentElement?.querySelector<HTMLElement>(".structured_status_saved")
    if (!saved) return
    saved.classList.toggle("structured_status_error", this.saveState === "failed")
    saved.textContent = this.saveState === "saving" ? "Saving…" : this.saveState === "failed" ? "Save failed" : "Saved"
  }
}
