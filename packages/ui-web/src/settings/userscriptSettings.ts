import { OnceClient } from "@once/app"
import {
  emptyUserscriptsDocument,
  removeUserscript,
  setUserscriptEnabled,
  summarizeUserscript,
  upsertUserscript,
  USERSCRIPT_TEMPLATE,
  UserscriptEntry,
  UserscriptsDocument,
  UserscriptSummary
} from "@once/core"
import { showConfirmDialog } from "../confirmDialog"
import { requireElement } from "../dom"
import { explained } from "../helpTip"

/**
 * The userscripts group: a list with one row per script, each with its own
 * switch, and a page per script with its header read out and its source to
 * edit. The whole-document text editor stays one page further in, for pasting
 * several scripts at once.
 */
export interface UserscriptSettings {
  /** Re-reads the document after a change made elsewhere. */
  refresh(): void
  /** Steps back out of a script page; false when the list is already showing. */
  handleBack(): boolean
}

type Page = { kind: "list" } | { kind: "script"; id: string } | { kind: "new" } | { kind: "bulk" }

// What phones run: see apps/mobile/extensions/once-surface/background.js and
// ExtensionSupport.swift. Anything else a script asks for is missing there.
const PHONE_GRANTS = new Set(["GM_addStyle", "GM_getValue", "GM_setValue"])

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text = ""
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text) node.textContent = text
  return node
}

function actionButton(label: string, testid: string, run: () => void): HTMLButtonElement {
  const button = element("button", "button", label)
  button.type = "button"
  button.dataset.testid = testid
  button.addEventListener("click", run)
  return button
}

/** `*://news.example.org/*` reads as the host; a catch-all as "All sites". */
export function userscriptSiteLabel(pattern: string): string {
  if (pattern === "<all_urls>" || pattern === "*") return "All sites"
  const match = /^(?:\*|[a-z][a-z0-9+.-]*):\/\/([^/]*)(\/.*)?$/i.exec(pattern)
  if (!match) return pattern
  const host = match[1].replace(/^\*\./, "")
  if (host === "*" || host === "") return "All sites"
  const path = match[2] && match[2] !== "/*" && match[2] !== "/" ? match[2] : ""
  return `${host}${path}`
}

function sitesSummary(summary: UserscriptSummary): string {
  const labels = [...new Set(summary.sites.map(userscriptSiteLabel))]
  if (labels.length === 0 || labels.includes("All sites")) return "All sites"
  return labels.length === 1 ? labels[0] : `${labels[0]} +${labels.length - 1}`
}

/** The script's own `@icon` where it has a usable one, else its initial. */
function scriptIcon(name: string, summary: UserscriptSummary | null): HTMLElement {
  const icon = element("span", "userscript_icon")
  icon.setAttribute("aria-hidden", "true")
  const letter = () => {
    icon.classList.remove("userscript_icon_image")
    icon.replaceChildren(document.createTextNode(name.trim().slice(0, 1).toUpperCase() || "?"))
  }
  letter()
  if (summary?.icon) {
    const image = element("img")
    image.alt = ""
    image.referrerPolicy = "no-referrer"
    image.decoding = "async"
    image.addEventListener("error", letter, { once: true })
    image.src = summary.icon
    icon.replaceChildren(image)
    icon.classList.add("userscript_icon_image")
  }
  return icon
}

function enabledSwitch(name: string, checked: boolean, change: (enabled: boolean) => void): HTMLInputElement {
  const toggle = element("input", "switch")
  toggle.type = "checkbox"
  toggle.checked = checked
  toggle.dataset.testid = "userscript-enabled"
  toggle.setAttribute("aria-label", `Run ${name}`)
  toggle.addEventListener("change", () => change(toggle.checked))
  return toggle
}

function phoneGaps(summary: UserscriptSummary): string[] {
  const gaps: string[] = []
  const missing = summary.grants.filter((grant) => !PHONE_GRANTS.has(grant))
  if (missing.length) gaps.push(`${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not available`)
  if (summary.requires.length) gaps.push("@require libraries are not loaded")
  return gaps
}

function fact(label: string, values: string[]): HTMLElement {
  const item = element("div", "userscript_fact")
  const value = element("dd")
  for (const text of values) value.append(element("span", "userscript_chip", text))
  item.append(element("dt", "", label), value)
  return item
}

/** What the header says about where and when the script runs. */
function scriptFacts(summary: UserscriptSummary, isPhone: boolean): HTMLElement[] {
  const facts = element("dl", "userscript_facts")
  facts.append(fact("Runs on", summary.sites.length ? summary.sites.map(userscriptSiteLabel) : ["All sites"]))
  if (summary.excludes.length) facts.append(fact("Skips", summary.excludes))
  facts.append(fact("Starts", [
    summary.runAt.replace("document-", "at document "),
    summary.noFrames ? "top page only" : "pages and frames"
  ]))
  if (summary.grants.length) facts.append(fact("Uses", summary.grants))
  const gaps = phoneGaps(summary)
  if (!gaps.length) return [facts]
  return [facts, element("p", "userscript_note",
    `${isPhone ? "On this phone" : "On phones"} ${gaps.join(" and ")}, so parts of this script may not work there.`)]
}

function scriptHeader(script: UserscriptEntry | undefined, summary: UserscriptSummary | null, toggle?: HTMLInputElement): HTMLElement {
  const name = script?.name ?? "New userscript"
  const top = element("div", "userscript_detail_header")
  const heading = element("div", "userscript_detail_title")
  const title = element("h3", "", name)
  title.tabIndex = -1
  heading.append(title)
  const sub = [summary?.version ? `Version ${summary.version}` : "", summary?.namespace ?? ""].filter(Boolean)
  if (script && sub.length) heading.append(element("span", "userscript_detail_sub", sub.join(" · ")))
  top.append(scriptIcon(name, summary), heading)
  if (toggle) {
    const label = element("label", "userscript_detail_switch")
    label.append(element("span", "", "Run"), toggle)
    top.append(label)
  }
  return top
}

function sourceEditor(loaded: string): { field: HTMLDivElement; textarea: HTMLTextAreaElement } {
  const label = element("label", "userscript_source_label", "Source")
  const textarea = element("textarea", "userscript_source")
  textarea.id = "userscript_source"
  textarea.spellcheck = false
  textarea.autocapitalize = "off"
  textarea.setAttribute("autocorrect", "off")
  textarea.wrap = "off"
  textarea.dataset.testid = "userscript-source"
  textarea.value = loaded
  label.htmlFor = textarea.id
  const field = element("div", "userscript_source_field")
  field.append(label, textarea)
  return { field, textarea }
}

interface Draft {
  textarea: HTMLTextAreaElement
  /** The text as it was loaded, to tell an edit from an untouched page. */
  loaded: string
  notice: HTMLElement
}

class UserscriptSettingsView implements UserscriptSettings {
  private readonly isPhone = document.body.dataset.platform === "mobile"
  private readonly list = element("div", "userscripts_page")
  private readonly detail = element("div", "userscripts_page userscript_detail")
  private readonly bulkPage = element("div", "userscripts_page")
  private readonly status = element("p", "settings_status userscripts_status")
  private doc: UserscriptsDocument = emptyUserscriptsDocument()
  private page: Page = { kind: "list" }
  private returnFocus: HTMLElement | null = null
  private savedHeader: { title: string; back: string } | null = null
  private draft: Draft | null = null
  // Writes go one at a time, each against the latest document, so two quick
  // toggles never race each other back to an older list.
  private writes = Promise.resolve()

  constructor(
    private readonly client: OnceClient,
    private readonly root: HTMLElement,
    bulk: HTMLElement,
    private readonly onChanged: () => void
  ) {
    this.status.setAttribute("role", "status")
    this.detail.hidden = true
    this.bulkPage.hidden = true
    this.bulkPage.append(bulk)
    bulk.hidden = false
    requireElement<HTMLElement>("h3", bulk).tabIndex = -1
    root.append(this.list, this.detail, this.bulkPage)
    this.bindNavigation()
    this.show({ kind: "list" })
    this.refresh()
  }

  refresh(): void {
    void this.client.getUserscripts().then((latest) => {
      this.doc = latest
      this.render()
    }).catch((error: unknown) => this.report(String(error), "failed"))
  }

  handleBack(): boolean {
    if (!this.active() || this.page.kind === "list" || this.root.closest("[hidden]")) return false
    void this.leave()
    return true
  }

  private active(): boolean {
    return this.root.closest(".settings_section")?.classList.contains("active") === true
  }

  private dirty(): boolean {
    return this.draft !== null && this.draft.textarea.value !== this.draft.loaded
  }

  private header(): { title: HTMLElement | null; back: HTMLButtonElement | null } {
    const panel = this.root.closest<HTMLElement>("#settings_panel")
    return {
      title: panel?.querySelector<HTMLElement>(".settings_title") ?? null,
      back: panel?.querySelector<HTMLButtonElement>("#settings_section_back") ?? null
    }
  }

  private bindNavigation(): void {
    // Ahead of the shells' own Back handlers, which would otherwise leave the
    // whole page, script and all.
    this.header().back?.addEventListener("click", (event) => {
      if (this.handleBack()) event.stopImmediatePropagation()
    }, true)
    this.root.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || this.page.kind === "list") return
      if (event.target instanceof Element && event.target.matches("textarea")) return
      event.stopPropagation()
      void this.leave()
    })
    const panel = this.root.closest<HTMLElement>("#settings_panel")
    if (!panel) return
    let wasActive = this.active()
    new MutationObserver(() => {
      const now = this.active()
      if (now === wasActive) return
      wasActive = now
      if (now) return
      this.savedHeader = null
      if (!this.dirty()) this.show({ kind: "list" })
    }).observe(panel, { subtree: true, attributes: true, attributeFilter: ["class"] })
  }

  private report(text: string, state?: "saving" | "saved" | "failed"): void {
    this.status.textContent = text
    if (state) this.status.dataset.state = state
    else delete this.status.dataset.state
  }

  private mutate(change: (latest: UserscriptsDocument) => UserscriptsDocument): Promise<void> {
    const work = this.writes.then(async () => {
      this.report("Saving…", "saving")
      await this.client.saveUserscripts(change(await this.client.getUserscripts()))
      this.doc = await this.client.getUserscripts()
      this.report("Saved · syncs to your other devices", "saved")
    })
    this.writes = work.catch(() => undefined)
    return work.catch((error: unknown) => {
      this.report(`Could not save: ${error instanceof Error ? error.message : String(error)}`, "failed")
      throw error
    })
  }

  private setEnabled(id: string, enabled: boolean): void {
    void this.mutate((latest) => setUserscriptEnabled(latest, id, enabled))
      .then(() => this.render(), () => this.render())
  }

  private render(): void {
    this.renderList()
    if (this.page.kind === "script" || this.page.kind === "new") this.renderOpenScript(this.page)
    this.placeStatus()
    this.onChanged()
  }

  private renderOpenScript(page: Page & { kind: "script" | "new" }): void {
    const id = page.kind === "script" ? page.id : null
    const current = this.doc.scripts.find((script) => script.id === id)
    if (!this.dirty()) {
      if (id && !current) this.show({ kind: "list" })
      else this.renderDetail()
      return
    }
    // The open script changed underneath an unsaved edit: say so, and leave
    // the choice to the user rather than dropping either side.
    if (id && (!current || current.source !== this.draft?.loaded)) this.showConflict(current)
  }

  private renderList(): void {
    const { scripts } = this.doc
    const enabled = scripts.filter((script) => script.enabled).length
    this.root.dataset.scriptCount = String(scripts.length)
    this.root.dataset.enabledCount = String(enabled)
    const intro = explained("Small scripts that change the pages Once opens.",
      "They sync with your other settings, " + (this.isPhone
        ? "and this phone runs them itself."
        : "and the desktop app hands them to Violentmonkey, whose own edits come back here."),
      "settings_group_hint userscripts_intro")
    const toolbar = element("div", "userscripts_toolbar")
    const off = scripts.length - enabled
    toolbar.append(
      element("span", "userscripts_count", scripts.length === 0 ? "No scripts" :
        `${scripts.length} ${scripts.length === 1 ? "script" : "scripts"}${off ? ` · ${off} off` : ""}`),
      actionButton("Add userscript", "add-userscript", () => this.show({ kind: "new" }))
    )
    toolbar.lastElementChild?.classList.add("userscripts_add")
    const rows = element("ul", "userscripts_list")
    rows.setAttribute("aria-label", "Userscripts")
    for (const script of scripts) rows.append(this.listRow(script))
    const empty = element("p", "userscripts_empty",
      "No userscripts yet. Add one here, or paste several at once as text.")
    empty.hidden = scripts.length > 0
    const asText = actionButton("Edit all as text…", "edit-userscripts-text", () => this.show({ kind: "bulk" }))
    asText.classList.add("userscripts_text_action")
    // Rebuilding the rows must not drop keyboard focus from the switch just used.
    const focused = document.activeElement instanceof HTMLElement && this.list.contains(document.activeElement)
      ? document.activeElement : null
    const focusedId = focused?.closest<HTMLElement>(".userscript_row")?.dataset.userscriptId
    this.list.replaceChildren(...intro, toolbar, rows, empty, asText)
    if (!focusedId) return
    const row = rows.querySelector<HTMLElement>(`[data-userscript-id="${CSS.escape(focusedId)}"]`)
    row?.querySelector<HTMLElement>(focused?.matches(".switch") ? ".switch" : ".userscript_row_main")
      ?.focus({ preventScroll: true })
  }

  private listRow(script: UserscriptEntry): HTMLLIElement {
    const summary = summarizeUserscript(script.source)
    const row = element("li", "userscript_row")
    row.dataset.userscriptId = script.id
    row.dataset.enabled = String(script.enabled)
    const main = element("button", "userscript_row_main")
    main.type = "button"
    main.dataset.testid = "open-userscript"
    main.setAttribute("aria-label", `Edit ${script.name}`)
    const text = element("span", "userscript_row_text")
    const title = element("span", "userscript_row_title")
    title.append(element("strong", "", script.name))
    if (summary?.version) title.append(element("span", "userscript_version", summary.version))
    text.append(title)
    if (summary?.description) text.append(element("span", "userscript_row_description", summary.description))
    const meta = [summary ? sitesSummary(summary) : "", script.enabled ? "" : "Off"].filter(Boolean)
    text.append(element("span", "userscript_row_meta", meta.join(" · ")))
    main.append(scriptIcon(script.name, summary), text)
    main.addEventListener("click", () => this.show({ kind: "script", id: script.id }))
    row.append(main, enabledSwitch(script.name, script.enabled, (on) => this.setEnabled(script.id, on)))
    return row
  }

  private renderDetail(): void {
    const openId = this.page.kind === "script" ? this.page.id : null
    const editing = this.doc.scripts.find((script) => script.id === openId)
    const loaded = editing?.source ?? USERSCRIPT_TEMPLATE
    const summary = summarizeUserscript(loaded)
    const toggle = editing && enabledSwitch(editing.name, editing.enabled, (on) => this.setEnabled(editing.id, on))
    const parts: HTMLElement[] = [scriptHeader(editing, summary, toggle)]
    if (editing && summary?.description) parts.push(element("p", "userscript_detail_description", summary.description))
    if (editing && summary) parts.push(...scriptFacts(summary, this.isPhone))
    if (!editing) {
      parts.push(...explained("Paste a script or fill in the header below.",
        "@match decides which sites it runs on; the name and namespace identify it on every device.",
        "settings_group_hint userscript_new_hint"))
    }
    const notice = element("p", "userscript_notice")
    notice.setAttribute("role", "status")
    notice.hidden = true
    const { field, textarea } = sourceEditor(loaded)
    this.draft = { textarea, loaded, notice }
    parts.push(notice, field,this.detailActions(editing, textarea))
    this.detail.replaceChildren(...parts)
  }

  private detailActions(editing: UserscriptEntry | undefined, textarea: HTMLTextAreaElement): HTMLElement {
    const save = actionButton(editing ? "Save" : "Add script", "save-userscript", () => void this.saveDraft())
    save.classList.add("userscript_primary")
    const revert = actionButton(editing ? "Revert" : "Cancel", "revert-userscript", () => {
      if (!editing) { void this.leave(); return }
      textarea.value = this.draft?.loaded ?? textarea.value
      updateDirty()
    })
    const actions = element("div", "userscript_actions")
    actions.append(save, revert)
    if (editing) {
      const remove = actionButton("Delete…", "delete-userscript", () => void this.deleteScript(editing))
      remove.classList.add("userscript_delete")
      actions.append(remove)
    }
    // A saved script's buttons wake up with an edit; a new one can be added as it stands.
    const updateDirty = () => {
      const changed = this.dirty()
      save.disabled = Boolean(editing) && !changed
      revert.disabled = Boolean(editing) && !changed
    }
    textarea.addEventListener("input", updateDirty)
    textarea.addEventListener("keydown", (event) => {
      if (event.key !== "s" || !(event.ctrlKey || event.metaKey)) return
      event.preventDefault()
      void this.saveDraft()
    })
    updateDirty()
    return actions
  }

  private async saveDraft(): Promise<void> {
    if (!this.draft) return
    const replacing = this.page.kind === "script" ? this.page.id : undefined
    const text = this.draft.textarea.value
    let savedId = ""
    try {
      await this.mutate((latest) => {
        // A script deleted elsewhere while it was open is added back as new.
        const target = latest.scripts.some((script) => script.id === replacing) ? replacing : undefined
        const { next, entry } = upsertUserscript(latest, text, { replacing: target })
        savedId = entry.id
        return next
      })
    } catch {
      return
    }
    this.page = { kind: "script", id: savedId }
    this.root.dataset.page = "script"
    this.draft = null
    this.render()
    this.setHeader()
  }

  private async deleteScript(script: UserscriptEntry): Promise<void> {
    const confirmed = await showConfirmDialog({
      message: `Delete “${script.name}”? It is removed from every device that syncs these settings.`,
      confirmLabel: "Delete",
      positionWithin: this.root
    })
    if (!confirmed) return
    try {
      await this.mutate((latest) => removeUserscript(latest, script.id))
    } catch {
      return
    }
    this.draft = null
    this.show({ kind: "list" })
    this.report(`Deleted ${script.name}`, "saved")
  }

  private showConflict(current: UserscriptEntry | undefined): void {
    if (!this.draft) return
    const { notice } = this.draft
    notice.replaceChildren(document.createTextNode(current
      ? "This script was changed on another device or in Violentmonkey. Saving keeps your version. "
      : "This script was deleted elsewhere. Saving adds it back. "))
    if (current) {
      notice.append(actionButton("Load their version", "load-latest-userscript", () => {
        this.draft = null
        this.renderDetail()
        this.placeStatus()
      }))
    }
    notice.hidden = false
  }

  // The one status line follows whichever page is showing; the text page has
  // its own, from the shared editor binding.
  private placeStatus(): void {
    const host = this.page.kind === "list" ? this.list : this.page.kind === "bulk" ? null : this.detail
    if (host && this.status.parentElement !== host) host.append(this.status)
  }

  private setHeader(): void {
    if (!this.active()) return
    const { title, back } = this.header()
    if (!title || !back) return
    const page = this.page
    if (page.kind === "list") {
      if (!this.savedHeader) return
      title.textContent = this.savedHeader.title
      back.textContent = this.savedHeader.back
      this.savedHeader = null
      return
    }
    this.savedHeader ??= { title: title.textContent ?? "", back: back.textContent ?? "" }
    title.textContent = page.kind === "bulk" ? "All userscripts" : page.kind === "new" ? "New userscript" :
      this.doc.scripts.find((script) => script.id === page.id)?.name ?? "Userscript"
    back.textContent = "Userscripts"
  }

  private show(next: Page): void {
    if (this.page.kind === "list" && next.kind !== "list") {
      this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    }
    this.page = next
    this.draft = null
    this.root.dataset.page = next.kind
    this.list.hidden = next.kind !== "list"
    this.detail.hidden = next.kind !== "script" && next.kind !== "new"
    this.bulkPage.hidden = next.kind !== "bulk"
    if (!this.detail.hidden) this.renderDetail()
    else if (next.kind === "list") this.renderList()
    this.report("")
    this.placeStatus()
    this.setHeader()
    this.focusPage(next.kind !== "list")
    // Focus goes to the page's heading, never its editor: on a phone that
    // would raise the keyboard over the page the user just opened. Back on
    // the list, the row that opened the page scrolls back into view.
    if (next.kind === "list") {
      if (this.returnFocus?.isConnected) this.returnFocus.focus()
      return
    }
    for (const scroller of [this.root.closest(".settings_section"), this.root.closest("#settings_panel")]) {
      scroller?.scrollTo?.({ top: 0 })
    }
    ;(next.kind === "bulk" ? this.bulkPage : this.detail).querySelector<HTMLElement>("h3")
      ?.focus({ preventScroll: true })
  }

  /**
   * A script's page is a page of its own: the filter lists and the section's
   * introduction beside the group step out of the way, and the group drops
   * its box, since the header already says Userscripts.
   */
  private focusPage(focused: boolean): void {
    const group = this.root.closest<HTMLElement>(".userscripts_group")
    group?.classList.toggle("userscripts_group_focused", focused)
    group?.parentElement?.classList.toggle("userscripts_focused", focused)
  }

  // Leaving a page with an unsaved edit asks first; everything else just goes.
  private async leave(): Promise<void> {
    if (this.dirty()) {
      const discard = await showConfirmDialog({
        message: "Discard your changes to this script?",
        confirmLabel: "Discard",
        cancelLabel: "Keep editing",
        positionWithin: this.root
      })
      if (!discard) return
    }
    this.show({ kind: "list" })
  }
}

export function bindUserscriptSettings(
  client: OnceClient,
  root: HTMLElement,
  bulk: HTMLElement,
  onChanged: () => void
): UserscriptSettings {
  return new UserscriptSettingsView(client, root, bulk, onChanged)
}
