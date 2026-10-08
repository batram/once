import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core"

export interface AddressBarPlugin {
  /** `explodable` adds "Explode" to the text menu, for the address editor. */
  setEditing(options: { editing: boolean; hasText: boolean; explodable?: boolean }): Promise<void>
  clipboardState?(): Promise<{ hasText: boolean }>
  readClipboard?(): Promise<{ text: string }>
  copyText?(options: { text: string; label?: string }): Promise<void>
  share?(options: { url: string; title?: string }): Promise<void>
  addListener(
    event: "pasteAndGo",
    listener: (event: { text: string }) => void
  ): Promise<PluginListenerHandle>
  addListener(event: "clear" | "explode", listener: () => void): Promise<PluginListenerHandle>
}

let nativeAddressBar: AddressBarPlugin | null | undefined

/** The native address bar plugin, or null in a browser build. */
export function addressBarPlugin(): AddressBarPlugin | null {
  if (nativeAddressBar === undefined) {
    nativeAddressBar = Capacitor.isNativePlatform() ? registerPlugin<AddressBarPlugin>("AddressBar") : null
  }
  return nativeAddressBar
}

/**
 * Empties the field the way typing would, so the keyboard drops any word it
 * is still composing instead of writing it back after a plain value reset.
 */
export function clearAddress(address: HTMLInputElement): void {
  address.focus()
  address.select()
  if (!document.execCommand("delete") || address.value !== "") {
    address.value = ""
    address.dispatchEvent(new Event("input", { bubbles: true }))
  }
}

/**
 * Offers "Paste and Go" and "Clear" in the native text menu of the address
 * field. The menu belongs to the shell WebView, so native code only adds the
 * items while this field has focus, then reports which one was chosen.
 */
export function installAddressMenu(
  address: HTMLInputElement,
  actions: { go: (text: string) => void; clear: () => void },
  plugin: AddressBarPlugin | null = addressBarPlugin()
): void {
  if (!plugin) return
  const report = (editing: boolean) =>
    void plugin.setEditing({ editing, hasText: address.value !== "" }).catch(() => undefined)
  address.addEventListener("focus", () => report(true))
  address.addEventListener("input", () => report(true))
  address.addEventListener("blur", () => report(false))
  void plugin.addListener("pasteAndGo", (event) => {
    const text = event.text.trim()
    if (text) actions.go(text)
  }).catch(() => undefined)
  void plugin.addListener("clear", () => actions.clear()).catch(() => undefined)
}
