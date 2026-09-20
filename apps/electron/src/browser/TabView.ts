import { WebContentsView } from "electron"
import { isAddonConversationUrl } from "../AddonConversationRelay"
import { PageProfile } from "../extensions/runtimeTypes"

declare const ADDON_CONVERSATION_PRELOAD_WEBPACK_ENTRY: string

export function createTabView(
  url: string, profile: PageProfile | null, partition: string,
  popupOptions?: Electron.BrowserWindowConstructorOptions
): WebContentsView {
  // Keep Electron's supplied popup contents and preferences so the page
  // receives a real WindowProxy, then enforce the ordinary tab protections.
  return new WebContentsView({
    ...popupOptions,
    webPreferences: {
      ...popupOptions?.webPreferences,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: true,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      disableHtmlFullscreenWindowResize: true,
      ...(profile
        ? { session: profile.session, preload: profile.preload }
        : isAddonConversationUrl(url)
          ? { partition, preload: ADDON_CONVERSATION_PRELOAD_WEBPACK_ENTRY }
          : { partition })
    }
  })
}
