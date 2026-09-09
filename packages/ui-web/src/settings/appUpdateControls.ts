export type AppUpdateState =
  | "disabled"
  | "idle"
  | "checking"
  | "available"
  | "current"
  | "downloaded"
  | "error"

export interface AppUpdateStatus {
  state: AppUpdateState
  message?: string
  manual?: boolean
  releaseUrl?: string
}

export interface AppUpdater {
  getStatus(): Promise<AppUpdateStatus>
  checkForUpdates(): Promise<AppUpdateStatus>
  onStatusChanged(handler: (status: AppUpdateStatus) => void): () => void
  openReleasePage?(url: string): Promise<unknown>
}

const DEFAULT_MESSAGES: Partial<Record<AppUpdateState, string>> = {
  disabled: "Updates are available in installed release builds.",
  available: "Downloading update…",
  current: "Up to date",
  downloaded: "Update downloaded. Restart to apply it.",
  error: "Update check failed"
}

export function bindAppUpdateControls(
  updater?: AppUpdater,
  reportError?: (message: string, details: string) => void
): void {
  const button = document.querySelector<HTMLInputElement | HTMLButtonElement>(
    "[data-testid='check-for-updates']"
  )
  const message = document.querySelector<HTMLElement>(
    "[data-testid='update-status']"
  )
  if (!button || !message || !updater) return
  const release = document.querySelector<HTMLAnchorElement>("[data-testid='release-page']")
  let current: AppUpdateStatus = { state: "idle" }

  button.hidden = false

  const render = (status: AppUpdateStatus): void => {
    current = status
    const busy = status.state === "checking" || (status.state === "available" && !status.manual)
    button.disabled = busy || status.state === "disabled" ||
      status.state === "downloaded"
    const label = status.state === "checking"
      ? "Checking…"
      : status.state === "available" && !status.manual
        ? "Downloading…"
        : status.manual ? "Check latest release" : "Check for updates"
    if (button.tagName === "INPUT") button.value = label
    else button.textContent = label
    message.textContent = status.message || DEFAULT_MESSAGES[status.state] || ""
    button.title = status.state === "disabled" ? message.textContent : ""
    if (release) {
      release.hidden = !status.releaseUrl
      if (status.releaseUrl) release.href = status.releaseUrl
      else release.removeAttribute("href")
    }
  }

  release?.addEventListener("click", event => {
    if (!updater.openReleasePage || !current.releaseUrl) return
    event.preventDefault()
    void updater.openReleasePage(current.releaseUrl).catch(error => {
      message.textContent = error instanceof Error ? error.message : "Could not open the release page."
    })
  })

  button.addEventListener("click", async () => {
    render({ ...current, state: "checking" })
    try {
      render(await updater.checkForUpdates())
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Update check failed"
      render({
        ...current,
        state: "error",
        message: detail
      })
      reportError?.(
        `Update check failed: ${detail}`,
        `Operation: updater.check\n\n${
          error instanceof Error ? error.stack || error.message : String(error)
        }`
      )
    }
  })

  updater.onStatusChanged(render)
  void updater.getStatus().then(render).catch((error) => {
    const detail = error instanceof Error ? error.message : "Update status unavailable"
    render({
      state: "error",
      message: detail
    })
    reportError?.(
      `Update status unavailable: ${detail}`,
      `Operation: updater.status\n\n${
        error instanceof Error ? error.stack || error.message : String(error)
      }`
    )
  })
}
