import { ELECTRON_IPC, ElectronPageAction, ElectronPageActionTarget } from "@once/platform-electron/bridge"
import { WindowEntry } from "./BrowserState"

/** Contribution ids look like `addon:<addon-id>/<action-id>`. */
const ID = /^[a-zA-Z0-9_.:/-]{1,200}$/

/**
 * The add-on actions each window's renderer offers for pages. Main never
 * runs one: a page's context menu lists them, and the chosen one goes back
 * to the renderer that listed it, with the page or link it was chosen for.
 */
export class PageActions {
  private readonly byWindow = new WeakMap<WindowEntry, ElectronPageAction[]>()

  set(owner: WindowEntry, items: unknown): void {
    this.byWindow.set(owner, readPageActions(items))
  }

  for(owner: WindowEntry): ElectronPageAction[] {
    return this.byWindow.get(owner) ?? []
  }

  run(owner: WindowEntry, id: string, page: ElectronPageActionTarget): void {
    if (owner.window.isDestroyed()) return
    owner.window.webContents.send(ELECTRON_IPC.addonsPageActionRun, id, page)
  }
}

/** The renderer's list as sent over IPC: only well-formed entries are kept. */
export function readPageActions(value: unknown): ElectronPageAction[] {
  if (!Array.isArray(value)) return []
  const actions: ElectronPageAction[] = []
  for (const item of value.slice(0, 50)) {
    const entry = item as Partial<ElectronPageAction> | null
    if (!entry || typeof entry.id !== "string" || !ID.test(entry.id)) continue
    if (typeof entry.label !== "string" || !entry.label.trim()) continue
    actions.push({ id: entry.id, label: entry.label.trim().slice(0, 100) })
  }
  return actions
}
