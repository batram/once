import { SettingsPanel } from "./SettingsPanel"

export interface ProcessingSource {
  domain: string
  parserType: string
}

export class LoaderInsights {
  private static el: HTMLElement | null = null
  private static timeout: ReturnType<typeof setTimeout> | null = null

  static init(): void {
    if (this.el) return

    const stories = document.querySelector("#stories")
    if (stories) {
      // Check if container already exists (retry mechanics)
      let notifContainer = document.querySelector("#notification_container")
      if (!notifContainer) {
        notifContainer = document.createElement("div")
        notifContainer.id = "notification_container"
        stories.insertAdjacentElement("afterend", notifContainer)
      }

      this.el = document.createElement("div")
      this.el.id = "loader_insights"
      notifContainer.appendChild(this.el)
    }
  }

  static show(message: string): void {
    if (!this.el) return

    this.el.textContent = message
    this.el.classList.add("visible")

    if (this.timeout) {
      clearTimeout(this.timeout)
      this.timeout = null
    }
  }

  static showProcessing(items: ProcessingSource[]): void {
    if (!this.el) return

    if (items.length === 0) {
      this.hide()
      return
    }

    this.el.replaceChildren()

    const label = document.createElement("div")
    label.classList.add("loader_insights_label")
    label.textContent =
      items.length === 1
        ? "Still processing 1 source"
        : `Still processing ${items.length} sources`
    this.el.appendChild(label)

    const list = document.createElement("div")
    list.classList.add("loader_insights_items")
    items.forEach((item) => {
      const itemEl = document.createElement("span")
      itemEl.classList.add("loader_insights_item")
      itemEl.classList.add("info")
      itemEl.dataset.type = `[${item.parserType}]`

      const type = document.createElement("span")
      type.classList.add("type")
      type.textContent = item.parserType
      itemEl.appendChild(type)

      const domain = document.createElement("span")
      domain.classList.add("loader_source_domain")
      domain.textContent = item.domain
      itemEl.appendChild(domain)

      list.appendChild(itemEl)
    })
    this.el.appendChild(list)

    this.el.classList.add("visible")

    if (this.timeout) {
      clearTimeout(this.timeout)
      this.timeout = null
    }
  }

  static showError(
    message: string,
    url?: string,
    detailedMessage?: string,
    source?: ProcessingSource
  ): void {
    const container = document.querySelector("#notification_container")
    if (!container) return

    // Deduplicate rendered errors without suppressing settings-backed errors.
    if (url) {
      const existingError = Array.from(
        container.querySelectorAll<HTMLElement>(".loader_error")
      ).find((el) => el.dataset.url === url)
      if (existingError) return
    }

    // Add error to SettingsPanel if the caller did not already do it.
    if (url && SettingsPanel.instance && !SettingsPanel.instance.hasError(url)) {
      SettingsPanel.instance.addSourceError(
        url,
        detailedMessage || message,
        "error"
      )
    }

    const errorEl = document.createElement("div")
    errorEl.classList.add("loader_error")
    if (url) {
      errorEl.dataset.url = url
    }

    const textSpan = document.createElement("span")
    textSpan.classList.add("loader_error_message")

    if (source) {
      const sourceEl = document.createElement("span")
      sourceEl.classList.add("loader_insights_item")
      sourceEl.classList.add("info")
      sourceEl.dataset.type = `[${source.parserType}]`

      const type = document.createElement("span")
      type.classList.add("type")
      type.textContent = source.parserType
      sourceEl.appendChild(type)

      const domain = document.createElement("span")
      domain.classList.add("loader_source_domain")
      domain.textContent = source.domain
      sourceEl.appendChild(domain)

      const label = document.createElement("span")
      label.textContent = message

      textSpan.appendChild(label)
      textSpan.appendChild(sourceEl)
    } else {
      textSpan.innerText = message
    }

    errorEl.appendChild(textSpan)

    // Close button (X)
    const closeBtn = document.createElement("span")
    closeBtn.classList.add("error_close")
    closeBtn.innerText = "×"
    closeBtn.onclick = (e) => {
      e.stopPropagation() // Don't navigate to settings
      errorEl.classList.remove("visible")
      setTimeout(() => errorEl.remove(), 300)
    }
    errorEl.appendChild(closeBtn)

    // Clicking the main area navigates to settings
    errorEl.onclick = () => {
      if (url && SettingsPanel.instance) {
        // Navigate to settings and highlight the specific source
        const failedMap = { [url]: detailedMessage || message }
        SettingsPanel.instance.highlight_sources(failedMap, true)
      }

      errorEl.classList.remove("visible")
      setTimeout(() => errorEl.remove(), 300)
    }
    container.appendChild(errorEl)

    // Trigger reflow to enable transition
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _ = errorEl.offsetHeight

    requestAnimationFrame(() => {
      errorEl.classList.add("visible")
    })
  }

  static hide(): void {
    if (!this.el) return

    // Allow a small delay before hiding so the last message is readable
    this.timeout = setTimeout(() => {
      this.el?.classList.remove("visible")
    }, 1000)
  }

  static resetErrors(): void {
    // Clear highlights in Settings panel using the new clean method
    if (SettingsPanel.instance) {
      SettingsPanel.instance.clearSourceErrors()
    }

    // Optionally remove existing error elements if we want a fresh start ui-wise too
    const container = document.querySelector("#notification_container")
    if (container) {
      container.querySelectorAll(".loader_error").forEach((el) => el.remove())
    }
  }
}
