import { Capacitor } from "@capacitor/core"
import { NativeInAppBrowser } from "./InAppBrowserSurface"

export interface MobileBrowserExtension {
  id: string
  name: string
  iconDataUrl?: string
  description: string
  version: string
  enabled: boolean
  bundled: boolean
  hasOptions: boolean
  hasAction: boolean
  permissions: string[]
  disabledReason: string
}

export interface MobileExtensionCommand {
  action: "list" | "install" | "chooseFile" | "enable" | "remove" | "update" | "options" | "action"
  id?: string
  source?: string
  enabled?: boolean
}

export interface MobileBrowserExtensions {
  readonly platform?: "android" | "ios"
  command(options: MobileExtensionCommand): Promise<{ extensions?: MobileBrowserExtension[]; cancelled?: boolean; noPage?: boolean }>
  onChanged(listener: () => void): Promise<() => void>
}

/** The extension commands the native surface plugin carries. */
export interface NativeExtensions {
  extensionCommand(options: MobileExtensionCommand): ReturnType<MobileBrowserExtensions["command"]>
  addListener(event: "extensionsChanged", listener: () => void): Promise<{ remove(): Promise<void> }>
}

export function createMobileBrowserExtensions(): MobileBrowserExtensions | null {
  const platform = Capacitor.getPlatform()
  if (platform !== "android" && platform !== "ios") return null
  let listing: ReturnType<MobileBrowserExtensions["command"]> | undefined
  return {
    platform,
    command(options) {
      if (options.action !== "list") return NativeInAppBrowser.extensionCommand(options)
      if (!listing) {
        listing = NativeInAppBrowser.extensionCommand(options).finally(() => { listing = undefined })
      }
      return listing
    },
    async onChanged(listener) {
      const subscription = await NativeInAppBrowser.addListener("extensionsChanged", listener)
      return () => { void subscription.remove() }
    }
  }
}
