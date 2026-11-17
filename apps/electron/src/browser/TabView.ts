import { WebContentsView } from "electron"
import { isAddonConversationUrl } from "../AddonConversationRelay"
import { isHistoryUrl } from "../HistoryPage"
import { isRemoteTabsUrl } from "../RemoteTabsRelay"
import { PageProfile } from "../extensions/runtimeTypes"

declare const ADDON_CONVERSATION_PRELOAD_WEBPACK_ENTRY: string
declare const REMOTE_TABS_PRELOAD_WEBPACK_ENTRY: string
declare const BROWSER_HISTORY_PRELOAD_WEBPACK_ENTRY: string

/**
 * What Electron hands a window-open `createWindow` callback. The pending
 * contents for a window.open popup ride along in `webContents`, which the
 * published typing leaves out.
 */
export type PopupWindowOptions = Electron.BrowserWindowConstructorOptions & {
  webContents?: Electron.WebContents
}

export function createTabView(
  url: string, profile: PageProfile | null, partition: string,
  popupOptions?: PopupWindowOptions
): WebContentsView {
  // Keep Electron's supplied popup contents and preferences so the page
  // receives a real WindowProxy, then enforce the ordinary tab protections.
  // A link opened in a new tab (middle click, Ctrl+click) has no pending
  // contents, yet Electron still passes the key with nothing in it, and
  // WebContentsView throws on that — which used to swallow the click.
  const { webContents, ...windowOptions } = popupOptions ?? {}
  return new WebContentsView({
    ...windowOptions,
    ...(webContents ? { webContents } : {}),
    webPreferences: {
      ...popupOptions?.webPreferences,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: true,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      disableHtmlFullscreenWindowResize: true,
      // Electron lets every page start sound on its own; browsers do not.
      // Like Chrome, a page plays once the user has clicked or typed in it,
      // and a muted video may still start by itself.
      autoplayPolicy: "document-user-activation-required",
      ...(profile
        ? { session: profile.session, preload: profile.preload }
        : isAddonConversationUrl(url)
          ? { partition, preload: ADDON_CONVERSATION_PRELOAD_WEBPACK_ENTRY }
          : isHistoryUrl(url)
            ? { partition, preload: BROWSER_HISTORY_PRELOAD_WEBPACK_ENTRY }
            : isRemoteTabsUrl(url)
              ? { partition, preload: REMOTE_TABS_PRELOAD_WEBPACK_ENTRY }
              : { partition })
    }
  })
}
