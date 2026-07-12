import { OnceClient, ProcessingSource, SourceError } from "@once/app"
import { SettingsPanel } from "./SettingsPanel"
import { requireElement } from "./dom"

interface LoaderInsightsOptions {
  showHoveredLinks?: boolean
}

type StatusKind = "error" | "info" | "link" | "loading" | "warning"

const INFO_FADE_DELAY = 2500
const ERROR_FADE_DELAY = 8000
const WARNING_COLLAPSE_DELAY = 5000

export class LoaderInsights {
  private static bar: HTMLElement | null = null
  private static message: HTMLElement | null = null
  private static messageText: HTMLElement | null = null
  private static activityIcon: HTMLElement | null = null
  private static warningIndicator: HTMLButtonElement | null = null
  private static errorIndicator: HTMLButtonElement | null = null
  private static processing: ProcessingSource[] = []
  private static sourceErrors: SourceError[] = []
  private static expandedIssue: SourceError | null = null
  private static hoveredUrl = ""
  private static infoMessage = ""
  private static infoKind: StatusKind = "info"
  private static wasProcessing = false
  private static infoTimeout: ReturnType<typeof setTimeout> | null = null
  private static warningTimeout: ReturnType<typeof setTimeout> | null = null
  private static commsRegistered = false
  private static hoverRegistered = false
  private static hoveredAnchor: HTMLAnchorElement | null = null

  static init(
    client?: OnceClient,
    options: LoaderInsightsOptions = {}
  ): void {
    this.ensureBar()

    if (!this.commsRegistered) {
      this.commsRegistered = true
      client?.subscribe("loaderChanged", ({ processing }) => {
        this.updateProcessing(processing)
      })
      client?.subscribe("sourceErrorsChanged", ({ errors }) => {
        this.updateSourceErrors(errors)
      })
    }

    if (options.showHoveredLinks) {
      this.registerHoveredLinks()
    }
  }

  private static ensureBar(): void {
    if (this.bar) return

    const guiRoot = document.querySelector("#left_main")
    if (!guiRoot) return

    const existingBar = document.querySelector<HTMLElement>("#status_bar")
    if (existingBar) {
      if (existingBar.parentElement !== guiRoot) {
        guiRoot.appendChild(existingBar)
      }
      this.bar = existingBar
      this.message = existingBar.querySelector("#status_bar_message")
      this.messageText = existingBar.querySelector("#status_bar_text")
      this.activityIcon = existingBar.querySelector("#status_bar_activity")
      this.warningIndicator = existingBar.querySelector(
        "#status_bar_warnings"
      )
      this.errorIndicator = existingBar.querySelector("#status_bar_errors")
      return
    }

    this.bar = document.createElement("div")
    this.bar.id = "status_bar"
    this.bar.setAttribute("role", "status")
    this.bar.setAttribute("aria-live", "polite")

    this.message = document.createElement("div")
    this.message.id = "status_bar_message"
    this.message.addEventListener("click", () => {
      if (
        this.message?.classList.contains("clickable") &&
        this.expandedIssue
      ) {
        SettingsPanel.instance?.highlightSource(this.expandedIssue.url)
      }
    })

    this.activityIcon = document.createElement("span")
    this.activityIcon.id = "status_bar_activity"
    this.activityIcon.setAttribute("aria-hidden", "true")
    this.message.appendChild(this.activityIcon)

    this.messageText = document.createElement("span")
    this.messageText.id = "status_bar_text"
    this.message.appendChild(this.messageText)
    this.bar.appendChild(this.message)

    const indicators = document.createElement("div")
    indicators.id = "status_bar_indicators"
    this.warningIndicator = this.createIssueIndicator("warning", "⚠")
    this.errorIndicator = this.createIssueIndicator("error", "!")
    indicators.append(this.warningIndicator, this.errorIndicator)
    this.bar.appendChild(indicators)

    guiRoot.appendChild(this.bar)
    this.render()
  }

  private static createIssueIndicator(
    type: "warning" | "error",
    symbol: string
  ): HTMLButtonElement {
    const indicator = document.createElement("button")
    indicator.id = `status_bar_${type}s`
    indicator.classList.add("status_issue", type)
    indicator.type = "button"
    indicator.hidden = true

    const icon = document.createElement("span")
    icon.classList.add("status_issue_icon")
    icon.setAttribute("aria-hidden", "true")
    icon.textContent = symbol
    indicator.appendChild(icon)

    const count = document.createElement("span")
    count.classList.add("status_issue_count")
    indicator.appendChild(count)

    indicator.addEventListener("click", () => {
      const issues = this.sourceErrors.filter((error) => error.type === type)
      if (issues.length === 0) return

      const currentIndex = issues.findIndex(
        (error) => error.url === this.expandedIssue?.url
      )
      const nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % issues.length
      this.expandedIssue = issues[nextIndex]
      this.clearInfoTimeout()
      this.render()
      if (type === "warning") this.scheduleWarningCollapse()
    })
    return indicator
  }

  private static updateProcessing(items: ProcessingSource[]): void {
    const isProcessing = items.length > 0
    this.processing = items

    if (isProcessing) {
      this.wasProcessing = true
      this.infoMessage = ""
      this.clearInfoTimeout()
    } else if (this.wasProcessing) {
      this.wasProcessing = false
      this.infoMessage = "Stories updated"
      this.infoKind = "info"
      this.scheduleInfoFade(INFO_FADE_DELAY)
    }

    this.render()
  }

  private static updateSourceErrors(errors: SourceError[]): void {
    this.sourceErrors = errors

    if (
      this.expandedIssue &&
      !errors.some((error) => error.url === this.expandedIssue?.url)
    ) {
      this.expandedIssue = null
    }

    const latestError = [...errors]
      .reverse()
      .find((error) => error.type === "error")
    const latestWarning = [...errors]
      .reverse()
      .find((error) => error.type === "warning")

    if (latestError) {
      this.expandedIssue = latestError
      this.clearWarningTimeout()
    } else if (latestWarning) {
      this.expandedIssue = latestWarning
      this.scheduleWarningCollapse()
    } else {
      this.expandedIssue = null
      this.clearWarningTimeout()
    }

    this.render()
  }

  private static registerHoveredLinks(): void {
    if (this.hoverRegistered) return
    this.hoverRegistered = true

    document.addEventListener("mouseover", (event) => {
      const target = event.target
      if (!(target instanceof Element)) return

      const anchor = target.closest<HTMLAnchorElement>("a[href]")
      if (!anchor || anchor === this.hoveredAnchor) return

      this.hoveredAnchor = anchor
      this.hoveredUrl = anchor.href || anchor.getAttribute("href") || ""
      this.render()
    })

    document.addEventListener("mouseout", (event) => {
      if (!this.hoveredAnchor) return

      const relatedTarget = event.relatedTarget
      if (
        relatedTarget instanceof Node &&
        this.hoveredAnchor.contains(relatedTarget)
      ) {
        return
      }

      const target = event.target
      if (!(target instanceof Node) || !this.hoveredAnchor.contains(target)) {
        return
      }

      this.hoveredAnchor = null
      this.hoveredUrl = ""
      this.render()
    })
  }

  static show(message: string): void {
    this.infoMessage = message
    this.infoKind = "info"
    this.scheduleInfoFade(INFO_FADE_DELAY)
    this.render()
  }

  static showErrorMessage(message: string): void {
    this.infoMessage = message
    this.infoKind = "error"
    this.scheduleInfoFade(ERROR_FADE_DELAY)
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
    this.infoKind = "info"
    this.clearInfoTimeout()
    this.render()
  }

  static resetErrors(): void {
    this.updateSourceErrors([])
  }

  private static render(): void {
    if (
      !this.bar ||
      !this.message ||
      !this.messageText ||
      !this.activityIcon
    ) {
      return
    }

    this.updateIndicator(this.warningIndicator, "warning")
    this.updateIndicator(this.errorIndicator, "error")

    let kind: StatusKind = "info"
    let text = ""
    let title = ""
    let clickable = false

    if (this.hoveredUrl) {
      kind = "link"
      text = this.hoveredUrl
      title = this.hoveredUrl
    } else if (this.processing.length > 0) {
      kind = "loading"
      const count = this.processing.length
      const domains = this.processing.map((item) => item.domain)
      text = `Loading ${count} ${count === 1 ? "source" : "sources"}`
      if (domains.length > 0) text += ` · ${domains.join(", ")}`
      title = this.processing
        .map((item) => `${item.domain} [${item.parserType}]`)
        .join("\n")
    } else if (this.expandedIssue) {
      kind = this.expandedIssue.type
      const matchingIssues = this.sourceErrors.filter(
        (error) => error.type === this.expandedIssue?.type
      )
      const issueIndex = matchingIssues.findIndex(
        (error) => error.url === this.expandedIssue?.url
      )
      const position =
        matchingIssues.length > 1 ? `${issueIndex + 1}/${matchingIssues.length} ` : ""
      text = `${position}${this.expandedIssue.title} · ${this.sourceLabel(
        this.expandedIssue.url
      )}`
      title = `${this.expandedIssue.message}\n${this.expandedIssue.url}`
      clickable = true
    } else if (this.infoMessage) {
      kind = this.infoKind
      text = this.infoMessage
      title = this.infoMessage
    }

    this.bar.dataset.kind = kind
    this.message.classList.toggle("visible", text.length > 0)
    this.message.classList.toggle("clickable", clickable)
    this.message.title = title
    this.messageText.textContent = text
    this.activityIcon.classList.toggle("spinning", kind === "loading")
  }

  private static updateIndicator(
    indicator: HTMLButtonElement | null,
    type: "warning" | "error"
  ): void {
    if (!indicator) return

    const issues = this.sourceErrors.filter((error) => error.type === type)
    const count = issues.length
    indicator.hidden = count === 0
    const countEl = requireElement<HTMLElement>(".status_issue_count", indicator)
    countEl.textContent = count.toString()
    indicator.setAttribute(
      "aria-label",
      `${count} source ${count === 1 ? type : `${type}s`}`
    )
    indicator.title = `${count} source ${
      count === 1 ? type : `${type}s`
    }. Click to show${count > 1 ? " next" : ""}.`
  }

  private static sourceLabel(url: string): string {
    return url.trim() || "Unknown source"
  }

  private static scheduleInfoFade(delay: number): void {
    this.clearInfoTimeout()
    this.infoTimeout = setTimeout(() => {
      this.infoMessage = ""
      this.infoKind = "info"
      this.infoTimeout = null
      this.render()
    }, delay)
  }

  private static scheduleWarningCollapse(): void {
    this.clearWarningTimeout()
    this.warningTimeout = setTimeout(() => {
      if (this.expandedIssue?.type === "warning") {
        this.expandedIssue = null
        this.render()
      }
      this.warningTimeout = null
    }, WARNING_COLLAPSE_DELAY)
  }

  private static clearInfoTimeout(): void {
    if (!this.infoTimeout) return
    clearTimeout(this.infoTimeout)
    this.infoTimeout = null
  }

  private static clearWarningTimeout(): void {
    if (!this.warningTimeout) return
    clearTimeout(this.warningTimeout)
    this.warningTimeout = null
  }
}
