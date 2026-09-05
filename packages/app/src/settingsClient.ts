import { AppSettings } from "./AppSettings"
import { sourceSecretKey } from "./sourceAuth"
import { OnceClient, SecretStorePort } from "./types"

type SettingsClientMethods = Pick<
  OnceClient,
  | "getFilterList" | "saveFilterList" | "getRedirectList" | "saveRedirectList"
  | "getFilterLists" | "saveFilterLists" | "getUserscripts" | "saveUserscripts"
  | "getAddons" | "saveAddons" | "updateAddons"
  | "getSyncUrl" | "setSyncUrl" | "getSourceSecret" | "setSourceSecret"
  | "getCacheTime" | "setCacheTime"
  | "getCacheTiming" | "setCacheTiming" | "getTheme" | "setTheme"
  | "getAnimation" | "setAnimation" | "getSwipeSettings" | "setSwipeSettings"
  | "getSaveBookmarkedContent" | "setSaveBookmarkedContent"
  | "addFilter"
>

/** The client methods that are one settings call each, with nothing else to do. */
export function settingsClientMethods(
  settings: AppSettings,
  secrets?: SecretStorePort
): SettingsClientMethods {
  const secretStore = () => {
    if (!secrets) throw new Error("This shell has nowhere to keep a source token")
    return secrets
  }
  return {
    getSourceSecret: async (sourceId) => secretStore().get(sourceSecretKey(sourceId)),
    setSourceSecret: async (sourceId, secret) =>
      secretStore().set(sourceSecretKey(sourceId), secret),
    getFilterList: () => settings.getFilterList(),
    saveFilterList: (filterList) => settings.saveFilterList(filterList),
    getRedirectList: () => settings.getRedirectList(),
    saveRedirectList: (redirectList) => settings.saveRedirectList(redirectList),
    getFilterLists: () => settings.getFilterLists(),
    saveFilterLists: (doc) => settings.saveFilterLists(doc),
    getUserscripts: () => settings.getUserscripts(),
    saveUserscripts: (doc) => settings.saveUserscripts(doc),
    getAddons: () => settings.getAddons(),
    saveAddons: (doc) => settings.saveAddons(doc),
    updateAddons: (change) => settings.updateAddons(change),
    getSyncUrl: () => settings.getSyncUrl(),
    setSyncUrl: (syncUrl) => settings.setSyncUrl(syncUrl),
    getCacheTime: () => settings.getCacheTime(),
    setCacheTime: (cacheTime) => settings.setCacheTime(cacheTime),
    getCacheTiming: () => settings.getCacheTiming(),
    setCacheTiming: (timing) => settings.setCacheTiming(timing),
    getTheme: () => settings.getTheme(),
    setTheme: (theme) => settings.setTheme(theme),
    getAnimation: () => settings.getAnimation(),
    setAnimation: (animated) => settings.setAnimation(animated),
    getSwipeSettings: () => settings.getSwipeSettings(),
    setSwipeSettings: (swipe) => settings.setSwipeSettings(swipe),
    getSaveBookmarkedContent: () => settings.getSaveBookmarkedContent(),
    setSaveBookmarkedContent: (enabled) => settings.setSaveBookmarkedContent(enabled),
    addFilter: (filter) => settings.addFilter(filter)
  }
}
