import type { TabSyncPlatform } from "@once/core"

const PLATFORM_NAMES: Record<TabSyncPlatform, string> = {
  electron: "Desktop app", ios: "iPhone or iPad", android: "Android", firefox: "Firefox", chrome: "Chrome"
}

/** How a device's platform is named wherever devices are listed. */
export function platformName(platform: string): string {
  return PLATFORM_NAMES[platform as TabSyncPlatform] ?? platform
}

/** A page's host without "www.", or the address itself when it has none. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "") || url
  } catch {
    return url
  }
}
