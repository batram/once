interface FirefoxBackgroundApi {
  action: { onClicked: { addListener(listener: () => void): void } }
  sidebarAction: { toggle(): void }
  contextMenus: {
    removeAll(): Promise<void>
    create(options: Record<string, unknown>): void
    onClicked: { addListener(listener: (info: { menuItemId?: string | number }) => void): void }
  }
  runtime: {
    getURL(path: string): string
    sendMessage(message: unknown): Promise<unknown>
  }
}

export async function initFirefoxBackground(api: FirefoxBackgroundApi): Promise<void> {
  api.action.onClicked.addListener(() => api.sidebarAction.toggle())
  await api.contextMenus.removeAll()
  api.contextMenus.create({
    id: "once_undo",
    title: "undo",
    contexts: ["all"],
    viewTypes: ["sidebar"],
    documentUrlPatterns: [api.runtime.getURL("/static/sidepanel.html")]
  })
  api.contextMenus.onClicked.addListener((info) => {
    if (info.menuItemId === "once_undo") {
      void api.runtime.sendMessage({ onceCommand: "history", action: "undo" })
    }
  })
}
