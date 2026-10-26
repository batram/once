import { ELECTRON_IPC } from "@once/platform-electron/bridge"
import { parseExtensionUrl } from "@once/webext-runtime"
import { hasReaderDocument } from "../ReaderProtocol"
import type { PageProfile } from "../extensions/runtimeTypes"
import type { TabEntry, WindowEntry } from "./BrowserState"
import type { ClosedTabRecord } from "./ClosedTabs"
import type { WindowSnapshot } from "./OpenTabs"
import { sourceUrlFromReaderUrl } from "./reader-url"

interface TabRestoreActions {
  createTab(owner: WindowEntry, url: string, active: boolean, after: string | null): Promise<string>
  get(id: string): TabEntry | undefined
  pageProfile(url: string): PageProfile | null
}

/** Opens tabs again from saved records: a closed tab, or a whole window of the previous session. */
export class TabRestore {
  constructor(private readonly actions: TabRestoreActions) {}

  /** A page of an extension that has since been removed cannot load anywhere. */
  canReopen(record: ClosedTabRecord): boolean {
    return !parseExtensionUrl(record.url) || this.actions.pageProfile(record.url) !== null
  }

  /** The tabs of a restored window, left to right, with the one that was active in front. */
  async openSession(state: WindowEntry, session: WindowSnapshot): Promise<void> {
    for (const [index, record] of session.tabs.entries()) {
      await this.openRecord(state, record, index === session.activeIndex, state.tabs.at(-1) ?? null)
    }
  }

  /**
   * A tab for a saved record, with its history. Reader documents only live
   * for the current session: after a restart the tab opens blank and the
   * shell regenerates the article for it, the same way a typed reader URL is
   * handled in navigate().
   */
  async openRecord(
    state: WindowEntry, record: ClosedTabRecord, active: boolean, after: string | null = state.activeId
  ): Promise<string> {
    const readerSource = sourceUrlFromReaderUrl(record.url)
    const regenerate = readerSource !== null && !hasReaderDocument(readerSource)
    const id = await this.actions.createTab(state, regenerate ? "about:blank" : record.url, active, after)
    if (regenerate) {
      state.window.webContents.send(ELECTRON_IPC.tabsRegenerateReader, readerSource, id)
    } else {
      this.restoreHistory(id, record)
    }
    return id
  }

  private restoreHistory(id: string, record: ClosedTabRecord): void {
    const history = record.history
    if (!history || history.entries.length < 2) return
    const entry = this.actions.get(id)
    if (!entry || entry.view.webContents.isDestroyed()) return
    try {
      entry.view.webContents.navigationHistory.restore({
        entries: history.entries,
        index: history.index
      })
    } catch {
      // The tab is already open at the right URL; back/forward is a bonus.
    }
  }
}
