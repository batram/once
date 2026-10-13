import { nativeTheme } from "electron"

/**
 * What a window or view shows before its document paints. Without it Electron
 * fills them white, which flashes in dark mode. These follow the OS scheme only:
 * the shell's own theme setting reaches main once the shell has loaded
 * (`setBackgroundColor`), too late for the first frames.
 */

/** The shell's `--main-bg-color` (parts/vars.css). */
export function shellBackground(): string {
  return nativeTheme.shouldUseDarkColors ? "#282a36" : "#f6f6ef"
}

/** The standalone menus' `:root` background (browserMenu.css, extensionMenu.css). */
export function menuBackground(): string {
  return nativeTheme.shouldUseDarkColors ? "#292a2d" : "#ffffff"
}
