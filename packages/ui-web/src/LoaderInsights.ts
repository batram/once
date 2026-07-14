import { OnceClient, ProcessingSource, SourceError } from "@once/app"
import { SettingsPanel } from "./SettingsPanel"
import { requireElement } from "./dom"

type IssueType = "warning" | "error"

interface UiIssue extends SourceError {
  id: string
  sourceIssue: boolean
}

const INFO_FADE_DELAY = 2500
const WARNING_DISMISS_DELAY = 5000

export class LoaderInsights {
  private static surfaces: HTMLElement | null = null
  private static bar: HTMLElement | null = null
  private static message: HTMLElement | null = null
  private static messageText: HTMLElement | null = null
  private static activityIcon: HTMLElement | null = null
  private static dock: HTMLElement | null = null
  private static activityIndicator: HTMLButtonElement | null = null
  private static warningIndicator: HTMLButtonElement | null = null
  private static errorIndicator: HTMLButtonElement | null = null
  private static processing: ProcessingSource[] = []
  private static sourceErrors: SourceError[] = []
  private static genericErrors: UiIssue[] = []
  private static dismissedIssues = new Set<string>()
  private static warningTimeouts = new Map<
    string,
    ReturnType<typeof setTimeout>
  >()
  private static infoMessage = ""
  private static wasProcessing = false
  private static statusCollapsed = false
  private static infoTimeout: ReturnType<typeof setTimeout> | null = null
  private static commsRegistered = false
  private static genericIssueId = 0

  static init(client?: OnceClient): void {
    this.ensureUi()

    if (this.commsRegistered) return
    this.commsRegistered = true
    client?.subscribe("loaderChanged", ({ processing }) => {
      this.updateProcessing(processing)
    })
    client?.subscribe("sourceErrorsChanged", ({ errors }) => {
      this.updateSourceErrors(errors)
    })
  }

  private static ensureUi(): void {
    if (this.bar) return

    const guiRoot = document.querySelector<HTMLElement>("#left_main")
    const menu = document.querySelector<HTMLElement>("#menu")
    if (!guiRoot || !menu) return

    document.querySelector("#status_bar")?.remove()

    this.surfaces = document.createElement("div")
    this.surfaces.id = "status_surfaces"

    this.bar = document.createElement("div")
    this.bar.id = "status_bar"
    this.bar.setAttribute("role", "status")
    this.bar.setAttribute("aria-live", "polite")

    this.message = document.createElement("div")
    this.message.id = "status_bar_message"

    this.activityIcon = document.createElement("span")
    this.activityIcon.id = "status_bar_activity"
    this.activityIcon.setAttribute("aria-hidden", "true")
    this.message.append(this.activityIcon)

    this.messageText = document.createElement("span")
    this.messageText.id = "status_bar_text"
    this.message.append(this.messageText)
    this.bar.append(this.message)
    this.surfaces.append(this.bar)
    guiRoot.append(this.surfaces)

    this.dock = document.createElement("div")
    this.dock.id = "status_dock"
    this.dock.setAttribute("aria-label", "Application status")
    this.activityIndicator = this.createIndicator("activity", "")
    this.warningIndicator = this.createIndicator("warning", "⚠")
    this.errorIndicator = this.createIndicator("error", "!")
    this.dock.append(
      this.activityIndicator,
      this.warningIndicator,
      this.errorIndicator
    )
    menu.append(this.dock)
    this.render()
  }

  private static createIndicator(
    type: "activity" | IssueType,
    symbol: string
  ): HTMLButtonElement {
    const indicator = document.createElement("button")
    indicator.id =
      type === "activity" ? "status_bar_state" : `status_bar_${type}s`
    indicator.classList.add("status_indicator", type)
    indicator.type = "button"
    indicator.hidden = true

    const icon = document.createElement("span")
    icon.classList.add("status_indicator_icon")
    icon.setAttribute("aria-hidden", "true")
    icon.textContent = symbol
    indicator.append(icon)

    if (type !== "activity") {
      const count = document.createElement("span")
      count.classList.add("status_indicator_count")
      indicator.append(count)
    }

    indicator.addEventListener("click", () => {
      if (type === "activity") {
        this.statusCollapsed = !this.statusCollapsed
      } else {
        this.toggleIssues(type)
      }
      this.render()
    })
    return indicator
  }

  private static updateProcessing(items: ProcessingSource[]): void {
    const isProcessing = items.length > 0
    const starting = isProcessing && this.processing.length === 0
    this.processing = items

    if (starting) {
      this.wasProcessing = true
      this.statusCollapsed = false
      this.infoMessage = ""
      this.clearInfoTimeout()
    } else if (!isProcessing && this.wasProcessing) {
      this.wasProcessing = false
      this.infoMessage = "Stories updated"
      this.scheduleInfoFade(INFO_FADE_DELAY)
    }

    this.render()
  }

  private static updateSourceErrors(errors: SourceError[]): void {
    if (errors.length === 0) {
      this.sourceErrors = []
      this.genericErrors = []
      this.dismissedIssues.clear()
      this.clearWarningTimeouts()
      this.render()
      return
    }

    const previousIds = new Set(this.sourceErrors.map((error) => this.issueId(error)))
    const currentIds = new Set(errors.map((error) => this.issueId(error)))

    for (const id of previousIds) {
      if (!currentIds.has(id)) {
        this.dismissedIssues.delete(id)
        this.clearWarningTimeout(id)
      }
    }

    this.sourceErrors = errors
    for (const error of errors) {
      const id = this.issueId(error)
      if (!previousIds.has(id)) {
        this.dismissedIssues.delete(id)
        if (error.type === "warning") this.scheduleWarningDismiss(id)
      }
    }
    this.render()
  }

  private static issues(): UiIssue[] {
    return [
      ...this.sourceErrors.map((error) => ({
        ...error,
        id: this.issueId(error),
        sourceIssue: true
      })),
      ...this.genericErrors
    ]
  }

  private static issueId(error: SourceError): string {
    return `source:${error.type}:${error.url}`
  }

  private static toggleIssues(type: IssueType): void {
    const issues = this.issues().filter((issue) => issue.type === type)
    const hasVisible = issues.some(
      (issue) => !this.dismissedIssues.has(issue.id)
    )

    if (hasVisible) {
      for (const issue of issues) {
        this.dismissedIssues.add(issue.id)
        this.clearWarningTimeout(issue.id)
      }
      return
    }

    for (const issue of issues) {
      this.dismissedIssues.delete(issue.id)
      if (type === "warning") this.scheduleWarningDismiss(issue.id)
    }
  }

  static show(message: string): void {
    this.infoMessage = message
    this.statusCollapsed = false
    this.scheduleInfoFade(INFO_FADE_DELAY)
    this.render()
  }

  static showErrorMessage(message: string): void {
    const issue: UiIssue = {
      id: `generic:error:${++this.genericIssueId}`,
      url: "",
      title: message,
      message,
      type: "error",
      sourceIssue: false
    }
    this.genericErrors.push(issue)
    this.dismissedIssues.delete(issue.id)
    this.render()
  }

  static showProcessing(items: ProcessingSource[]): void {
    this.updateProcessing(items)
  }

  static showError(error: SourceError): void {
    const remaining = this.sourceErrors.filter((item) => item.url !== error.url)
    this.updateSourceErrors([...remaining, error])
  }

  static hide(): void {
    this.infoMessage = ""
    this.clearInfoTimeout()
    this.render()
  }

  static resetErrors(): void {
    this.updateSourceErrors([])
  }

  private static render(): void {
    if (
      !this.surfaces ||
      !this.bar ||
      !this.message ||
      !this.messageText ||
      !this.activityIcon
    ) {
      return
    }

    const loading = this.processing.length > 0
    let text = this.infoMessage
    let title = this.infoMessage
    if (loading) {
      const count = this.processing.length
      const domains = this.processing.map((item) => item.domain)
      text = `Loading ${count} ${count === 1 ? "source" : "sources"}`
      if (domains.length > 0) text += ` · ${domains.join(", ")}`
      title = this.processing
        .map((item) => `${item.domain} [${item.parserType}]`)
        .join("\n")
    }

    const hasStatus = text.length > 0
    this.bar.hidden = !hasStatus || this.statusCollapsed
    this.bar.dataset.kind = loading ? "loading" : "info"
    this.message.title = title
    this.messageText.textContent = text
    this.activityIcon.classList.toggle("spinning", loading)

    this.renderIndicator(this.activityIndicator, "activity", hasStatus)
    this.renderIndicator(this.warningIndicator, "warning")
    this.renderIndicator(this.errorIndicator, "error")
    if (this.dock) {
      this.dock.hidden = ![
        this.activityIndicator,
        this.warningIndicator,
        this.errorIndicator
      ].some((indicator) => indicator && !indicator.hidden)
    }
    this.renderIssues()
  }

  private static renderIndicator(
    indicator: HTMLButtonElement | null,
    type: "activity" | IssueType,
    hasStatus = false
  ): void {
    if (!indicator) return

    if (type === "activity") {
      indicator.hidden = !hasStatus
      indicator.classList.toggle("spinning", this.processing.length > 0)
      indicator.classList.toggle("collapsed", this.statusCollapsed)
      indicator.title = this.statusCollapsed ? "Show status" : "Hide status"
      indicator.setAttribute("aria-label", indicator.title)
      indicator.setAttribute("aria-expanded", String(!this.statusCollapsed))
      return
    }

    const count = this.issues().filter((issue) => issue.type === type).length
    indicator.hidden = count === 0
    const countEl = requireElement<HTMLElement>(
      ".status_indicator_count",
      indicator
    )
    countEl.textContent = count.toString()
    const visible = this.issues().some(
      (issue) =>
        issue.type === type && !this.dismissedIssues.has(issue.id)
    )
    indicator.classList.toggle("collapsed", !visible)
    indicator.setAttribute(
      "aria-label",
      `${count} ${count === 1 ? type : `${type}s`}. ${
        visible ? "Hide" : "Show"
      } details.`
    )
    indicator.setAttribute("aria-expanded", String(visible))
    indicator.title = indicator.getAttribute("aria-label") || ""
  }

  private static renderIssues(): void {
    if (!this.surfaces) return
    this.surfaces
      .querySelectorAll(".status_issue_bubble")
      .forEach((element) => element.remove())

    const allIssues = this.issues()
    const issues = allIssues
      .filter((issue) => !this.dismissedIssues.has(issue.id))
      .sort((left, right) => {
        if (left.type !== right.type) return left.type === "error" ? -1 : 1
        return allIssues.indexOf(right) - allIssues.indexOf(left)
      })

    for (const issue of issues) {
      const bubble = document.createElement("div")
      bubble.classList.add("status_issue_bubble", issue.type)
      bubble.dataset.issueId = issue.id
      bubble.setAttribute("role", issue.type === "error" ? "alert" : "status")

      const content = document.createElement("button")
      content.type = "button"
      content.classList.add("status_issue_content")
      content.disabled = !issue.sourceIssue
      content.title = issue.sourceIssue
        ? `${issue.message}\n${issue.url}`
        : issue.message

      const title = document.createElement("span")
      title.classList.add("status_issue_title")
      title.textContent = issue.title
      content.append(title)

      if (issue.url) {
        const source = document.createElement("span")
        source.classList.add("status_issue_source")
        source.textContent = issue.url.trim() || "Unknown source"
        content.append(source)
      }

      if (issue.sourceIssue) {
        content.addEventListener("click", () => {
          SettingsPanel.instance?.highlightSource(issue.url)
        })
      }

      const close = document.createElement("button")
      close.type = "button"
      close.classList.add("status_issue_close")
      close.textContent = "×"
      close.title = `Hide ${issue.type}`
      close.setAttribute("aria-label", close.title)
      close.addEventListener("click", (event) => {
        event.stopPropagation()
        this.dismissedIssues.add(issue.id)
        this.clearWarningTimeout(issue.id)
        this.render()
      })

      bubble.append(content, close)
      this.surfaces.append(bubble)
    }
  }

  private static scheduleInfoFade(delay: number): void {
    this.clearInfoTimeout()
    this.infoTimeout = setTimeout(() => {
      this.infoMessage = ""
      this.infoTimeout = null
      this.render()
    }, delay)
  }

  private static scheduleWarningDismiss(id: string): void {
    this.clearWarningTimeout(id)
    this.warningTimeouts.set(
      id,
      setTimeout(() => {
        this.dismissedIssues.add(id)
        this.warningTimeouts.delete(id)
        this.render()
      }, WARNING_DISMISS_DELAY)
    )
  }

  private static clearInfoTimeout(): void {
    if (!this.infoTimeout) return
    clearTimeout(this.infoTimeout)
    this.infoTimeout = null
  }

  private static clearWarningTimeout(id: string): void {
    const timeout = this.warningTimeouts.get(id)
    if (!timeout) return
    clearTimeout(timeout)
    this.warningTimeouts.delete(id)
  }

  private static clearWarningTimeouts(): void {
    for (const timeout of this.warningTimeouts.values()) clearTimeout(timeout)
    this.warningTimeouts.clear()
  }
}
