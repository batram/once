// One add-on page action, run by the page that shows its result. A browser
// context menu can name a page action while no Once panel is open to run it;
// the tab it opens then becomes the add-on's host for that one run: the same
// registration, sandbox and tray the panel would use, over the same stored
// add-ons, options and tokens, but without starting the story list, its
// database sync or its collectors.
import type { OnceClient } from "@once/app"
import { setOnceClient } from "../client"
import { addonVaultReady } from "./addonVaultGate"
import type { AddonConversationHandle } from "./AddonTrays"
import type { BundledAddonFiles } from "./bundledAddons"
import { AddonConversationPort, mountAddonConversation } from "./conversationPage"
import { mountAddons } from "./mountAddons"
import { AddonPage, PAGE_ADDON_ACTIONS_CHANGED, pageAddonActions, runPageAddonAction } from "./pageAddons"

export interface PageActionHostOptions {
  sandboxUrl: string
  bundledAddons?: readonly BundledAddonFiles[]
  /** How long the action may take to register before the page gives up. */
  registrationMs?: number
}

const NOT_AVAILABLE = "This add-on action is not available: the add-on may be disabled or removed, or does not apply to this page."
const STOPPED = "The add-on stopped before it could finish. Check it under Settings → Add-ons in the Once panel, then choose the action again."

/** Resolves once `action` applies to `page`, or false when it never registers in time. */
function registered(action: string, page: AddonPage, timeout: number): Promise<boolean> {
  return new Promise(resolve => {
    const done = (value: boolean): void => {
      document.removeEventListener(PAGE_ADDON_ACTIONS_CHANGED, check)
      clearTimeout(timer)
      resolve(value)
    }
    const check = (): void => { if (pageAddonActions("menu", page).some(item => item.id === action)) done(true) }
    const timer = setTimeout(() => done(false), timeout)
    document.addEventListener(PAGE_ADDON_ACTIONS_CHANGED, check)
    check()
  })
}

/**
 * Runs `action` on `page` and shows its tray's conversation in `root`. False,
 * with the reason in `root`, when the add-on is missing, disabled, does not
 * apply to the page, or cannot run here.
 *
 * Changing an add-on's options ends its conversations. In the panel the reader
 * reopens the tray; here the run starts again by itself, so options fixed in the
 * panel (a model, an endpoint, a token) apply to this tab without reopening it.
 */
export async function hostPageAction(
  client: OnceClient, root: HTMLElement, action: string, page: AddonPage, options: PageActionHostOptions
): Promise<boolean> {
  setOnceClient(client)
  if (!await addonVaultReady(client, root)) return false
  const timeout = options.registrationMs ?? 15_000
  let unmount: (() => void) | null = null
  let settingsChanged = false
  let restarting = false
  const show = (text: string): void => {
    unmount?.()
    unmount = null
    root.textContent = text
  }
  const start = async (): Promise<boolean> => {
    if (!await registered(action, page, timeout) || !runPageAddonAction(action, page, "continue")) {
      show(NOT_AVAILABLE)
      return false
    }
    // An action without a tray has done its work by now and has nothing to show.
    if (!unmount) show("Done. You can close this tab.")
    return true
  }
  const ended = (): void => {
    if (!settingsChanged) { show(STOPPED); return }
    settingsChanged = false
    if (restarting) return
    restarting = true
    // The registration finishes applying the new options before the action runs again.
    queueMicrotask(() => { void start().finally(() => { restarting = false }) })
  }
  const port = (handle: AddonConversationHandle): AddonConversationPort => ({
    subscribe(listener) {
      listener(handle.snapshot(), true)
      return handle.subscribe(snapshot => { if (snapshot) listener(snapshot, true); else ended() })
    },
    send: command => handle.send(command)
  })
  client.subscribe("settingsChanged", ({ section }) => { if (section === "addons") settingsChanged = true })
  mountAddons(client, {
    sandboxUrl: options.sandboxUrl,
    bundledAddons: options.bundledAddons,
    pageOnly: true,
    conversations: {
      label: "",
      open(handle) {
        unmount?.()
        root.replaceChildren()
        unmount = mountAddonConversation(root, port(handle))
      }
    }
  })
  return start()
}
