import { AppSettings } from "./AppSettings"
import { OnceClient } from "./types"

type SettingsClientMethods = Pick<
  OnceClient,
  | "getFilterList" | "saveFilterList" | "getRedirectList" | "saveRedirectList"
  | "getFilterLists" | "saveFilterLists" | "getUserscripts" | "saveUserscripts"
  | "getSyncUrl" | "setSyncUrl" | "getCacheTime" | "setCacheTime"
  | "getCacheTiming" | "setCacheTiming" | "getTheme" | "setTheme"
  | "getAnimation" | "setAnimation" | "getSwipeSettings" | "setSwipeSettings"
  | "addFilter"
>

/** The client methods that are one settings call each, with nothing else to do. */
export function settingsClientMethods(settings: AppSettings): SettingsClientMethods {
  return {
    getFilterList: () => settings.getFilterList(),
    saveFilterList: (filterList) => settings.saveFilterList(filterList),
    getRedirectList: () => settings.getRedirectList(),
    saveRedirectList: (redirectList) => settings.saveRedirectList(redirectList),
    getFilterLists: () => settings.getFilterLists(),
    saveFilterLists: (doc) => settings.saveFilterLists(doc),
    getUserscripts: () => settings.getUserscripts(),
    saveUserscripts: (doc) => settings.saveUserscripts(doc),
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
    addFilter: (filter) => settings.addFilter(filter)
  }
}
