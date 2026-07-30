import { parseRedirectList, Redirect } from "@once/core"
import {
  createActionButton,
  createInlineActionButton,
  createListCard,
  createRowBody,
  createRowChevron,
  StructuredFormField
} from "./form"
import { installRowDragReorder } from "./dragReorder"
import { parseFilterRows } from "./filters"
import {
  parseRedirectRows,
  RedirectRow,
  serializeRedirectRows
} from "./redirects"

export interface FlatSettingsHost {
  onTouch(): boolean
  closeOpenEditor(): void
  setOpenEditor(close: (() => void) | null): void
  enterFilterDetail(): void
  listActions(section: "filters" | "redirects"): HTMLElement | null
  renderListStatus(root: HTMLElement, count: number, noun: string): void
  render(section: "filters" | "redirects"): void
  root(section: "filters" | "redirects"): HTMLElement | undefined
  setText(section: "filters" | "redirects", text: string): void
  showForm(
    root: HTMLElement,
    title: string,
    fields: StructuredFormField[],
    save: (values: string[]) => boolean,
    remove: { label: string; action: () => void } | undefined,
    presentation: { host?: HTMLElement; redirectTester?: boolean }
  ): void
  saveFilters(values: string[]): void
  saveRedirects(values: Redirect[]): void
}

export class FlatSettingsEditors {
  private filters: string[] = []
  private redirects: RedirectRow[] = []
  private pendingFilterRevealIndex: number | null = null
  private filterRevealTimer: number | null = null

  constructor(private host: FlatSettingsHost) {}

  readFilters(text: string): void {
    this.filters = parseFilterRows(text)
  }

  readRedirects(text: string): void {
    this.redirects = parseRedirectRows(text)
  }

  focusFilter(filter: string): boolean {
    const root = this.host.root("filters")
    const target = Array.from(root?.querySelectorAll<HTMLButtonElement>(
      "[data-filter-value]"
    ) || []).find((button) => button.dataset.filterValue === filter)
    target?.focus({ preventScroll: true })
    target?.scrollIntoView({ block: "center" })
    target?.click()
    return true
  }

  editFilterAt(root: HTMLElement, index: number): void {
    this.editFilter(root, index)
    const input = root.querySelector<HTMLInputElement>(
      "[data-testid='filter-inline-input']"
    )
    const row = input?.closest<HTMLElement>(".structured_row")
    row?.classList.add("structured_row_target")
    window.setTimeout(
      () => row?.classList.remove("structured_row_target"),
      1600
    )
  }

  renderFilters(root: HTMLElement): void {
    if (!this.host.onTouch()) {
      this.host.listActions("filters")?.append(
        createActionButton(
          "Add filter",
          () => this.editFilter(root),
          "add-filter"
        )
      )
    }
    this.host.renderListStatus(root, this.filters.length, "keyword")
    const { card, rows } = createListCard(
      "Keyword filters",
      this.filters.length
    )
    this.filters.forEach((value, index) => {
      const row = document.createElement("div")
      row.className = "structured_row structured_row_unbadged"
      row.draggable = true
      row.dataset.filterIndex = String(index)
      row.dataset.searchValue = value.toLowerCase()
      const open = createActionButton(
        value,
        () => this.editFilter(root, index),
        "filter-row"
      )
      open.className = "structured_row_main"
      open.dataset.filterValue = value
      const remove = createActionButton("×", () => {
        if (!window.confirm(`Delete filter “${value}”?`)) return
        this.filters.splice(index, 1)
        this.saveFilters()
      }, "remove-filter")
      remove.className = "structured_remove"
      remove.title = `Delete filter ${value}`
      remove.setAttribute("aria-label", remove.title)
      row.append(createRowBody(open, remove))
      installRowDragReorder(rows, row, index, (from, destination) => {
        if (from >= this.filters.length) return
        const [moved] = this.filters.splice(from, 1)
        this.filters.splice(destination, 0, moved)
        this.saveFilters()
      })
      rows.append(row)
    })
    root.append(card)
    this.applyPendingFilterReveal()
  }

  editFilter(root: HTMLElement, index?: number): void {
    this.host.closeOpenEditor()
    const rows = root.querySelector<HTMLElement>(".structured_rows")
    if (!rows) return
    this.host.enterFilterDetail()
    const isNew = index === undefined
    const row = isNew
      ? document.createElement("div")
      : rows.children.item(index) as HTMLElement | null
    if (!row) return
    if (isNew) {
      row.className = "structured_row"
      rows.append(row)
    }
    const original = isNew ? "" : this.filters[index]
    row.textContent = ""
    row.classList.add("structured_row_editing")
    const input = document.createElement("input")
    input.type = "text"
    input.className = "structured_inline_input"
    input.dataset.testid = "filter-inline-input"
    input.value = original
    input.setAttribute(
      "aria-label",
      isNew ? "New filter" : `Edit filter ${original}`
    )
    const validation = document.createElement("span")
    validation.className = "structured_inline_validation"
    validation.setAttribute("role", "alert")
    const cancel = () => {
      this.host.setOpenEditor(null)
      this.host.render("filters")
    }
    const save = () => {
      const value = input.value
      if (!value.trim()) {
        if (isNew) cancel()
        else {
          validation.textContent = "Filter cannot be empty"
          input.focus()
        }
        return
      }
      this.host.setOpenEditor(null)
      const savedIndex = index ?? this.filters.length
      if (isNew) this.filters.push(value)
      else this.filters[savedIndex] = value
      if (isNew) this.pendingFilterRevealIndex = savedIndex
      this.saveFilters()
    }
    this.host.setOpenEditor(() => {
      if (!row.isConnected) return
      if (!input.value.trim() || input.value === original) cancel()
      else save()
    })
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault()
        save()
      } else if (event.key === "Escape") {
        event.preventDefault()
        cancel()
      }
    })
    input.addEventListener("blur", () => {
      window.setTimeout(() => {
        if (document.activeElement === input || !row.isConnected) return
        save()
      }, 0)
    })
    const accept = createInlineActionButton(
      "Save",
      save,
      "save-inline-filter"
    )
    const dismiss = createInlineActionButton("Cancel", cancel)
    this.host.listActions("filters")
    row.append(input, validation, accept, dismiss)
    input.focus({ preventScroll: true })
    input.select()
    if (isNew) {
      requestAnimationFrame(() => {
        if (row.isConnected) row.scrollIntoView({ block: "center" })
      })
    }
  }

  renderRedirects(root: HTMLElement): void {
    if (!this.host.onTouch()) {
      this.host.listActions("redirects")?.append(
        createActionButton(
          "Add redirect",
          () => this.editRedirect(root),
          "add-redirect"
        )
      )
    }
    this.host.renderListStatus(root, this.redirects.length, "rule")
    const { card, rows } = createListCard("Redirects", this.redirects.length)
    this.redirects.forEach((redirect, index) => {
      const row = document.createElement("div")
      row.className = "structured_row structured_row_unbadged" +
        (redirect.invalid ? " invalid" : "")
      row.draggable = true
      row.dataset.searchValue = [
        redirect.raw,
        redirect.match_url,
        redirect.replace_url
      ].filter(Boolean).join(" ").toLowerCase()
      const open = document.createElement("button")
      open.type = "button"
      open.draggable = true
      open.className = "structured_row_main"
      open.dataset.testid = "redirect-row"
      const match = document.createElement("span")
      match.className = "structured_row_primary"
      match.textContent = redirect.invalid
        ? redirect.raw || ""
        : redirect.match_url
      const replacement = document.createElement("span")
      replacement.className = "structured_row_secondary"
      replacement.textContent = redirect.invalid
        ? 'Not a "match => replace" line'
        : `=> ${redirect.replace_url}`
      if (redirect.invalid) {
        replacement.classList.add("structured_row_secondary_error")
        open.title = "Invalid redirect — edit as text or repair this row"
      }
      open.append(match, replacement)
      open.addEventListener("click", () => this.editRedirect(root, index))
      const label = redirect.raw || redirect.match_url
      const remove = createActionButton("×", () => {
        if (!window.confirm(`Delete redirect “${label}”?`)) return
        this.redirects.splice(index, 1)
        this.saveRedirects()
      }, "remove-redirect")
      remove.className = "structured_remove"
      remove.title = `Delete redirect ${label}`
      remove.setAttribute("aria-label", remove.title)
      row.append(createRowBody(
        open,
        createRowChevron(
          `Edit redirect ${redirect.raw}`,
          () => this.editRedirect(root, index)
        ),
        remove
      ))
      installRowDragReorder(rows, row, index, (from, destination) => {
        if (from >= this.redirects.length) return
        const [moved] = this.redirects.splice(from, 1)
        this.redirects.splice(destination, 0, moved)
        this.saveRedirects()
      })
      rows.append(row)
    })
    root.append(card)
  }

  editRedirect(root: HTMLElement, index?: number): void {
    this.host.closeOpenEditor()
    const redirect = index === undefined
      ? { match_url: "", replace_url: "" }
      : this.redirects[index]
    let formHost: HTMLElement | undefined
    if (!this.host.onTouch()) {
      const rows = root.querySelector<HTMLElement>(".structured_rows")
      const existing = index === undefined
        ? null
        : rows?.children.item(index) as HTMLElement | null
      formHost = existing || document.createElement("div")
      if (!existing) rows?.append(formHost)
      formHost.className =
        "structured_row structured_row_editing structured_redirect_editor"
      formHost.draggable = false
      formHost.textContent = ""
    }
    this.host.showForm(root, "Redirect rule", [
      ["Match", redirect.match_url, {
        multiline: true,
        hint: "JavaScript regular expression, matched against the whole story URL."
      }],
      ["Replace", redirect.replace_url, {
        multiline: true,
        hint: "Backreferences $1… refer to the groups above."
      }]
    ], (values) => {
      if (!values[0].trim() || !values[1].trim()) return false
      const next = { match_url: values[0], replace_url: values[1] }
      if (index === undefined) this.redirects.push(next)
      else this.redirects[index] = next
      this.saveRedirects()
      return true
    }, index === undefined ? undefined : {
      label: "Delete rule",
      action: () => {
        if (!window.confirm("Delete this redirect?")) return
        this.redirects.splice(index, 1)
        this.saveRedirects()
      }
    }, { host: formHost, redirectTester: true })
  }

  private applyPendingFilterReveal(): void {
    const index = this.pendingFilterRevealIndex
    if (index === null) return
    if (this.filterRevealTimer !== null) {
      window.clearTimeout(this.filterRevealTimer)
      this.filterRevealTimer = null
    }
    requestAnimationFrame(() => {
      if (this.pendingFilterRevealIndex !== index) return
      const root = this.host.root("filters")
      const row = root?.querySelector<HTMLElement>(
        `[data-filter-index="${index}"]`
      )
      const button = row?.querySelector<HTMLButtonElement>(
        "[data-filter-value]"
      )
      if (!row || !button) return
      button.focus({ preventScroll: true })
      row.scrollIntoView({ block: "center" })
      row.classList.add("structured_row_target")
      this.filterRevealTimer = window.setTimeout(() => {
        if (this.pendingFilterRevealIndex !== index) return
        this.pendingFilterRevealIndex = null
        this.filterRevealTimer = null
        this.host.root("filters")?.querySelector<HTMLElement>(
          `[data-filter-index="${index}"]`
        )?.classList.remove("structured_row_target")
      }, 1600)
    })
  }

  private saveFilters(): void {
    const text = this.filters.join("\n")
    this.host.setText("filters", text)
    this.host.saveFilters([...this.filters])
    this.host.render("filters")
  }

  private saveRedirects(): void {
    const text = serializeRedirectRows(this.redirects)
    this.host.setText("redirects", text)
    this.host.saveRedirects(parseRedirectList(text))
    this.host.render("redirects")
  }
}
