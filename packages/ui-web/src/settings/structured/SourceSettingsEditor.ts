import { SourceError } from "@once/app"
import { showChoiceDialog, showConfirmDialog } from "../../confirmDialog"
import { AnchoredMenuItem } from "../../menu/storyAnchoredMenu"
import { StructuredFormField } from "./form"
import { SourceGroupView } from "./SourceGroupView"
import {
  parseSourceGroups,
  SourceGroup,
  serializeSourceGroups
} from "./sourceGroups"

export interface SourceSettingsHost {
  onTouch(): boolean
  getText(): string
  setText(text: string): void
  render(): void
  root(): HTMLElement | undefined
  saveSources(values: string[], reloadStories?: boolean): void | Promise<void>
  showSourceError(source: string): void
  openMenu(anchor: HTMLElement, items: AnchoredMenuItem[]): void
  listActions(): HTMLElement | null
  showForm(
    root: HTMLElement,
    title: string,
    fields: StructuredFormField[],
    save: (values: string[]) => boolean,
    remove?: { label: string; action: () => void },
    choices?: Array<[string, string]>
  ): void
}

export class SourceSettingsEditor {
  readonly groups: SourceGroup[] = []
  private errors = new Map<string, SourceError>()
  private saveState: "saved" | "saving" | "failed" = "saved"
  private revealSource: string | null = null
  private revealTimer: number | null = null
  private view: SourceGroupView

  constructor(private host: SourceSettingsHost) {
    this.view = new SourceGroupView({
      groups: this.groups,
      errors: this.errors,
      onTouch: () => this.host.onTouch(),
      edit: (root, group, source) => this.editSource(root, group, source),
      editGroup: (root, group) => this.editGroup(root, group),
      deleteGroup: (root, group) => this.deleteGroup(root, group),
      save: (reload) => this.save(reload),
      showError: (source) => this.host.showSourceError(source),
      openMenu: (anchor, items) => this.host.openMenu(anchor, items),
      listActions: () => this.host.listActions()
    })
  }

  read(text = this.host.getText()): void {
    const previous = [...this.groups]
    const parsed = parseSourceGroups(text.split("\n"))
    const used = new Set<number>()
    parsed.slice(1).forEach((group) => {
      let match = previous.findIndex((candidate, index) =>
        index > 0 && !used.has(index) &&
        candidate.name === group.name &&
        candidate.sources.length === group.sources.length &&
        candidate.sources.every((source, sourceIndex) =>
          source === group.sources[sourceIndex])
      )
      if (match < 0) {
        match = previous.findIndex((candidate, index) =>
          index > 0 && !used.has(index) && candidate.name === group.name)
      }
      if (match > 0) {
        group.id = previous[match].id
        used.add(match)
      }
    })
    this.groups.splice(0, this.groups.length, ...parsed)
  }

  render(root: HTMLElement): void {
    this.view.render(root)
    this.renderSaveState(root)
  }

  setErrors(errors: SourceError[]): void {
    this.errors.clear()
    errors.forEach((error) => this.errors.set(error.url.trim(), error))
  }

  contains(source: string): boolean {
    return this.groups.some((group) =>
      group.sources.some((entry) => entry.trim() === source.trim()))
  }

  reveal(source: string): void {
    const value = source.trim()
    const group = this.groups.find((entry) =>
      entry.sources.some((item) => item.trim() === value))
    if (!group) return
    this.revealSource = value
    this.view.expand(group.id)
    this.applyReveal()
  }

  applyReveal(): void {
    const source = this.revealSource
    if (!source) return
    if (this.revealTimer !== null) window.clearTimeout(this.revealTimer)
    requestAnimationFrame(() => {
      if (this.revealSource !== source) return
      const root = this.host.root()
      const target = Array.from(root?.querySelectorAll<HTMLButtonElement>(
        "[data-source-value]"
      ) || []).find((button) => button.dataset.sourceValue === source)
      const details = target?.closest<HTMLDetailsElement>(".structured_group")
      if (!target || !details) return
      details.open = true
      target.focus({ preventScroll: true })
      target.scrollIntoView({ block: "center" })
      target.classList.add("structured_row_target")
      this.revealTimer = window.setTimeout(() => {
        if (this.revealSource !== source) return
        this.revealSource = null
        this.revealTimer = null
        target.classList.remove("structured_row_target")
      }, 1600)
    })
  }

  editSource(
    root: HTMLElement,
    groupIndex = 0,
    sourceIndex?: number
  ): void {
    const current = sourceIndex === undefined
      ? "" : this.groups[groupIndex].sources[sourceIndex]
    this.host.showForm(root, "Source", [
      ["Source", current],
      ["Group", String(groupIndex)]
    ], (values) => {
      const value = values[0].trim()
      const target = Number(values[1])
      if (!value || !this.groups[target]) return false
      if (sourceIndex !== undefined) {
        this.groups[groupIndex].sources.splice(sourceIndex, 1)
      }
      if (sourceIndex !== undefined && target === groupIndex) {
        this.groups[target].sources.splice(sourceIndex, 0, value)
      } else {
        this.groups[target].sources.push(value)
      }
      this.save()
      return true
    }, sourceIndex === undefined ? undefined : {
      label: "Delete source",
      action: () => {
        if (!window.confirm("Delete this story source?")) return
        this.groups[groupIndex].sources.splice(sourceIndex, 1)
        this.save()
      }
    }, this.groups.map((group, index) => [String(index), group.name]))
  }

  editGroup(root: HTMLElement, groupIndex?: number): void {
    const current = groupIndex === undefined ? "" : this.groups[groupIndex].name
    this.host.showForm(root, "Group", [["Group name", current]], (values) => {
      const name = values[0].trim()
      if (!name) return false
      if (groupIndex === undefined) {
        this.groups.push({ id: `group-${Date.now()}`, name, sources: [] })
      } else {
        this.groups[groupIndex].name = name
      }
      this.save()
      return true
    })
  }

  async deleteGroup(root: HTMLElement, groupIndex: number): Promise<void> {
    const group = this.groups[groupIndex]
    if (!group.sources.length) {
      if (window.confirm(`Delete group “${group.name}”?`)) {
        this.groups.splice(groupIndex, 1)
        this.save()
      }
      return
    }
    const choice = await showChoiceDialog({
      title: `Delete “${group.name}”?`,
      message: "Choose what should happen to the sources in this group.",
      choices: [
        {
          label: "Remove group and move sources to Default",
          value: "move"
        },
        { label: "Remove group and its sources", value: "remove" }
      ],
      positionWithin: root
    })
    if (choice === "move") {
      this.groups[0].sources.push(...group.sources)
    } else if (choice === "remove") {
      const confirmed = await showConfirmDialog({
        message: `Permanently delete ${group.sources.length} sources?`,
        confirmLabel: "Delete",
        positionWithin: root
      })
      if (!confirmed) return
    } else {
      return
    }
    this.groups.splice(groupIndex, 1)
    this.save()
  }

  save(reloadStories = true): void {
    const values = serializeSourceGroups(this.groups)
    this.host.setText(values.join("\n"))
    this.saveState = "saving"
    this.host.render()
    Promise.resolve(this.host.saveSources(values, reloadStories)).then(
      () => {
        this.saveState = "saved"
        this.renderSaveState(this.host.root())
      },
      () => {
        this.saveState = "failed"
        this.renderSaveState(this.host.root())
      }
    )
  }

  private renderSaveState(root?: HTMLElement): void {
    const saved = root?.parentElement?.querySelector<HTMLElement>(
      ".structured_status_saved"
    )
    if (!saved) return
    saved.classList.toggle(
      "structured_status_error",
      this.saveState === "failed"
    )
    saved.textContent = this.saveState === "saving"
      ? "Saving…"
      : this.saveState === "failed" ? "Save failed" : "Saved"
  }
}
