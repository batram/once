import { dialog } from "electron"
import { ELECTRON_IPC } from "@once/platform-electron/bridge"
import { normalizeBrowserUrl } from "@once/platform-electron/navigation"
import { NativeMenus } from "./NativeMenus"
import { NavigationErrors, sameUrl } from "./NavigationErrors"
import { TabEntry, WindowEntry } from "./BrowserState"

interface TabOwnerAccess {
  ownerFor(entry: TabEntry): WindowEntry | undefined
  notify(entry: TabEntry): void
}

interface NavigationActions extends TabOwnerAccess {
  applyRedirects(url: string): string
}

class TabNavigationEvents {
  private readonly titlePreservingReloads = new WeakSet<TabEntry>()

  constructor(
    private readonly errors: NavigationErrors,
    private readonly actions: NavigationActions
  ) {}

  preserveTitleOnNextNavigation(entry: TabEntry): void {
    this.titlePreservingReloads.add(entry)
  }

  bind(entry: TabEntry): void {
    const contents = entry.view.webContents
    const changed = () => this.actions.notify(entry)
    contents.on("did-start-loading", () => {
      entry.loading = true
      changed()
    })
    contents.on("did-stop-loading", () => {
      entry.loading = false
      changed()
    })
    contents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
      if (!isMainFrame || code === -3 || this.errors.state(entry, url)) return
      if (url && !sameUrl(url, entry.displayedUrl)) return
      this.errors.handleFailure(entry, url || entry.displayedUrl, `${description} (${code})`)
    })
    contents.on("did-start-navigation", (event) => {
      if (!event.isMainFrame || event.isSameDocument) return
      const preserveTitle = this.titlePreservingReloads.delete(entry)
      const errorPage = this.errors.state(entry, event.url)
      if (errorPage) {
        this.errors.restore(entry, event.url, errorPage)
        return
      }
      this.reset(entry, event.url)
      entry.audible = false
      entry.hasPlayedAudio = false
      if (entry.muted) contents.setAudioMuted(false)
      entry.muted = false
      if (!preserveTitle) entry.title = "New tab"
      changed()
    })
    contents.on("did-redirect-navigation", (event) => {
      if (!event.isMainFrame || event.isSameDocument) return
      entry.displayedUrl = event.url
      changed()
    })
    contents.on("did-navigate", (_event, url) => this.didNavigate(entry, url, changed))
    contents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
      if (isMainFrame) this.didNavigate(entry, url, changed)
    })
    contents.on("did-finish-load", () => {
      const owner = this.actions.ownerFor(entry)
      if (owner && this.errors.state(entry, contents.getURL())) {
        this.errors.applyTheme(entry, owner.backgroundColor)
      }
    })
    contents.on("will-navigate", (event, url) => {
      try {
        const normalized = normalizeBrowserUrl(url)
        const redirected = this.actions.applyRedirects(normalized)
        if (redirected !== normalized) {
          event.preventDefault()
          this.errors.load(entry, normalizeBrowserUrl(redirected))
        }
      } catch {
        event.preventDefault()
      }
    })
  }

  private didNavigate(entry: TabEntry, url: string, changed: () => void): void {
    const errorPage = this.errors.state(entry, url)
    if (errorPage) {
      this.errors.restore(entry, url, errorPage)
      this.errors.collapseFailedEntry(entry)
      return
    }
    this.reset(entry, url)
    changed()
  }

  private reset(entry: TabEntry, url: string): void {
    entry.displayedUrl = url
    entry.loadError = null
    entry.loadErrorRetryable = false
    entry.errorPageUrl = null
  }
}

interface WindowInteractionActions extends TabOwnerAccess {
  createTab(owner: WindowEntry, url: string, active: boolean): Promise<string>
  createWindow(url: string): Promise<void>
  setFullscreen(owner: WindowEntry, fullscreen: boolean): void
}

class TabWindowInteractionEvents {
  constructor(
    private readonly menus: NativeMenus,
    private readonly actions: WindowInteractionActions
  ) {}

  bind(entry: TabEntry): void {
    const contents = entry.view.webContents
    contents.on("update-target-url", (_event, url) => {
      const owner = this.actions.ownerFor(entry)
      if (owner?.activeId === entry.id && !owner.window.isDestroyed()) {
        owner.window.webContents.send(ELECTRON_IPC.windowTargetUrlChanged, url)
      }
    })
    contents.on("will-prevent-unload", (event) => {
      const owner = this.actions.ownerFor(entry)
      if (!owner || owner.window.isDestroyed()) return
      const choice = dialog.showMessageBoxSync(owner.window, {
        type: "question",
        buttons: ["Leave", "Stay"],
        defaultId: 0,
        cancelId: 1,
        title: "Do you want to leave this site?",
        message: "Changes you made may not be saved."
      })
      if (choice === 0) event.preventDefault()
    })
    contents.on("enter-html-full-screen", () => this.enterFullscreen(entry))
    contents.on("leave-html-full-screen", () => this.leaveFullscreen(entry))
    contents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown" || input.isAutoRepeat) return
      const owner = this.actions.ownerFor(entry)
      if (!owner) return
      if (input.key === "F11") {
        event.preventDefault()
        if (entry.htmlFullscreen) void contents.executeJavaScript("document.exitFullscreen()")
        else this.actions.setFullscreen(owner, !owner.window.isFullScreen())
      } else if (
        input.key === "Escape" &&
        owner.window.isFullScreen() &&
        !entry.htmlFullscreen
      ) {
        event.preventDefault()
        this.actions.setFullscreen(owner, false)
      }
    })
    contents.setWindowOpenHandler(({ url, disposition }) => {
      const owner = this.actions.ownerFor(entry)
      if (!owner) return { action: "deny" }
      try {
        const normalized = normalizeBrowserUrl(url)
        if (disposition === "new-window") void this.actions.createWindow(normalized)
        else void this.actions.createTab(owner, normalized, disposition !== "background-tab")
      } catch {
        // Unsupported schemes are intentionally denied.
      }
      return { action: "deny" }
    })
    contents.on("context-menu", (_event, params) => {
      const owner = this.actions.ownerFor(entry)
      if (owner) this.menus.showContentsMenu(owner, contents, params)
    })
  }

  private enterFullscreen(entry: TabEntry): void {
    const owner = this.actions.ownerFor(entry)
    if (!owner) return
    entry.htmlFullscreen = true
    this.sendFullscreen(owner, true)
    this.actions.setFullscreen(owner, true)
  }

  private leaveFullscreen(entry: TabEntry): void {
    const owner = this.actions.ownerFor(entry)
    entry.htmlFullscreen = false
    if (!owner) return
    this.sendFullscreen(owner, false)
    this.actions.setFullscreen(owner, false)
  }

  private sendFullscreen(owner: WindowEntry, fullscreen: boolean): void {
    if (!owner.window.isDestroyed()) {
      owner.window.webContents.send(ELECTRON_IPC.windowFullscreenChanged, fullscreen)
    }
  }
}

interface LifecycleActions extends TabOwnerAccess {
  finalizeClosedTab(entry: TabEntry): void
}

class TabLifecycleEvents {
  constructor(private readonly actions: LifecycleActions) {}

  bind(entry: TabEntry): void {
    const contents = entry.view.webContents
    const changed = () => this.actions.notify(entry)
    contents.on("page-title-updated", (_event, title) => {
      entry.title = title || "New tab"
      changed()
    })
    contents.on("audio-state-changed", (event) => {
      entry.audible = event.audible
      if (event.audible) entry.hasPlayedAudio = true
      changed()
    })
    contents.on("destroyed", () => this.actions.finalizeClosedTab(entry))
  }
}

export class TabEvents {
  private readonly navigation: TabNavigationEvents
  private readonly interaction: TabWindowInteractionEvents
  private readonly lifecycle: TabLifecycleEvents

  constructor(
    errors: NavigationErrors,
    menus: NativeMenus,
    navigationActions: NavigationActions,
    interactionActions: WindowInteractionActions,
    lifecycleActions: LifecycleActions
  ) {
    this.navigation = new TabNavigationEvents(errors, navigationActions)
    this.interaction = new TabWindowInteractionEvents(menus, interactionActions)
    this.lifecycle = new TabLifecycleEvents(lifecycleActions)
  }

  bind(entry: TabEntry): void {
    this.navigation.bind(entry)
    this.interaction.bind(entry)
    this.lifecycle.bind(entry)
  }

  preserveTitleOnNextNavigation(entry: TabEntry): void {
    this.navigation.preserveTitleOnNextNavigation(entry)
  }
}
