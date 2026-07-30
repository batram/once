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
}

export interface AppUpdater {
  getStatus(): Promise<AppUpdateStatus>
  checkForUpdates(): Promise<AppUpdateStatus>
  onStatusChanged(handler: (status: AppUpdateStatus) => void): () => void
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
  const button = document.querySelector<HTMLInputElement>(
    "[data-testid='check-for-updates']"
  )
  const message = document.querySelector<HTMLElement>(
    "[data-testid='update-status']"
  )
  if (!button || !message || !updater) return

  button.hidden = false

  const render = (status: AppUpdateStatus): void => {
    const busy = status.state === "checking" || status.state === "available"
    button.disabled = busy || status.state === "disabled" ||
      status.state === "downloaded"
    button.value = status.state === "checking"
      ? "Checking…"
      : status.state === "available"
        ? "Downloading…"
        : "Check for updates"
    message.textContent = status.message || DEFAULT_MESSAGES[status.state] || ""
    button.title = status.state === "disabled" ? message.textContent : ""
  }

  button.addEventListener("click", async () => {
    render({ state: "checking" })
    try {
      render(await updater.checkForUpdates())
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Update check failed"
      render({
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
