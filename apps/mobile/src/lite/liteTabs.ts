// Tabs as Java reports them (`tab.changed`, `tab.removed`) and the
// `ExtensionShellHooks` the API handlers call, which ask Java to create,
// update, remove and reload WebViews. Tab lifecycle becomes `tabs.*` and
// `webNavigation.*` events for every loaded extension, as Electron's runtime
// does from `WebContents` events; here the facts come from `Page.*` events
// of the tab's target. A `moz-extension://` URL asked for as a tab opens one
// of the extension's pages instead (`openExtensionPage`).

import { ApiHost, ExtensionShellHooks, TabSnapshot, TabUpdateProps, parseExtensionUrl } from "@once/webext-runtime"
import { JavaChannel } from "./javaChannel"
import { TabCreateParams, TabState, TabUpdateParams } from "./protocol"

export interface TabRecord extends TabSnapshot {
  generation: number
  targetId: string | null
}

export interface LiteTabsOptions {
  channel: JavaChannel
  hosts(): Iterable<ApiHost>
  /** Opens one of an extension's own pages; answers whether a page was opened. */
  openExtensionPage(url: string): Promise<boolean>
  /** A tab went away: contexts, grants and per-tab state of every host go with it. */
  onTabRemoved(tabId: number): void
}

export class LiteTabs implements ExtensionShellHooks {
  private readonly records = new Map<number, TabRecord>()
  private readonly listeners = new Set<() => void>()
  private lastActive: number | undefined

  constructor(private readonly options: LiteTabsOptions) {
    options.channel.onEvent("tab.changed", (params) => this.changed(params as TabState))
    options.channel.onEvent("tab.removed", (params) => this.removed((params as { tabId: number }).tabId))
  }

  tabs(): TabSnapshot[] {
    return [...this.records.values()]
      .sort((a, b) => a.index - b.index)
      .map(({ generation: _generation, targetId: _targetId, ...tab }) => tab)
  }

  record(tabId: number): TabRecord | undefined {
    return this.records.get(tabId)
  }

  tabIdOfTarget(targetId: string): number | undefined {
    for (const record of this.records.values()) if (record.targetId === targetId) return record.id
    return undefined
  }

  /** Java attached the tab's WebView to a DevTools target. */
  attachTarget(tabId: number, targetId: string): void {
    const record = this.records.get(tabId)
    if (record) record.targetId = targetId
  }

  async createTab(url: string, active: boolean): Promise<TabSnapshot | null> {
    if (parseExtensionUrl(url)) {
      await this.options.openExtensionPage(url)
      return null
    }
    const { tabId } = await this.options.channel.request<{ tabId: number }>("tab.create", { url, active } satisfies TabCreateParams)
    return this.tabs().find((tab) => tab.id === tabId) ?? null
  }

  async updateTab(id: number, props: TabUpdateProps): Promise<TabSnapshot | null> {
    if (!this.records.has(id)) throw new Error(`Invalid tab ID: ${id}`)
    if (props.url && parseExtensionUrl(props.url)) {
      await this.options.openExtensionPage(props.url)
      return this.tabs().find((tab) => tab.id === id) ?? null
    }
    await this.options.channel.request("tab.update", { tabId: id, ...props } satisfies TabUpdateParams)
    return this.tabs().find((tab) => tab.id === id) ?? null
  }

  /** One window, one order: the surface keeps its own; the tab is reported where it is. */
  async moveTab(id: number): Promise<TabSnapshot | null> {
    return this.tabs().find((tab) => tab.id === id) ?? null
  }

  async removeTab(id: number): Promise<void> {
    if (!this.records.has(id)) throw new Error(`Invalid tab ID: ${id}`)
    await this.options.channel.request("tab.remove", { tabId: id })
  }

  async reloadTab(id: number): Promise<void> {
    if (!this.records.has(id)) throw new Error(`Invalid tab ID: ${id}`)
    await this.options.channel.request("tab.reload", { tabId: id })
  }

  onTabsChanged(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Navigation facts from the tab target's `Page.*` events. */
  frameNavigated(tabId: number, url: string, frameId: number, parentFrameId: number, sameDocument: boolean): void {
    const navigation = { tabId, url, frameId, parentFrameId, timeStamp: Date.now() }
    if (!sameDocument) this.emit("webNavigation", "onBeforeNavigate", [navigation])
    this.emit("webNavigation", "onCommitted", [{ ...navigation, transitionType: "link", transitionQualifiers: [] }])
    const record = this.records.get(tabId)
    if (frameId === 0 && record && record.url !== url) {
      record.url = url
      this.emit("tabs", "onUpdated", [tabId, { url }, this.snapshot(record)])
    }
  }

  domContentLoaded(tabId: number): void {
    const record = this.records.get(tabId)
    if (!record) return
    this.emit("webNavigation", "onDOMContentLoaded", [{ tabId, url: record.url, frameId: 0, parentFrameId: -1, timeStamp: Date.now() }])
  }

  loaded(tabId: number): void {
    const record = this.records.get(tabId)
    if (!record) return
    this.emit("webNavigation", "onCompleted", [{ tabId, url: record.url, frameId: 0, parentFrameId: -1, timeStamp: Date.now() }])
  }

  private snapshot(record: TabRecord): TabSnapshot {
    const { generation: _generation, targetId: _targetId, ...tab } = record
    return tab
  }

  private emit(api: string, event: string, args: unknown[]): void {
    for (const host of this.options.hosts()) host.contexts.emit(api, event, args)
  }

  private changed(state: TabState): void {
    const existing = this.records.get(state.tabId)
    if (existing && existing.generation !== state.generation) this.removed(state.tabId)
    const previous = this.records.get(state.tabId)
    // Java reports a tab active while its view is the visible foreground; an
    // extension's popup or the native menu over it takes that away, but a
    // browser's active tab stays active until another tab is selected, and
    // the popup asks for it (`tabs.query {active: true}`).
    const active = state.active || this.lastActive === state.tabId
    const record: TabRecord = {
      id: state.tabId, generation: state.generation, targetId: state.targetId ?? previous?.targetId ?? null,
      windowId: 1, index: state.index, url: state.url, title: state.title, active,
      status: state.status, audible: state.audible, mutedInfo: { muted: state.muted },
      incognito: false, highlighted: active, pinned: false
    }
    this.records.set(state.tabId, record)
    if (active && this.lastActive !== undefined && this.lastActive !== record.id) {
      const former = this.records.get(this.lastActive)
      if (former) {
        former.active = false
        former.highlighted = false
      }
    }
    const tab = this.snapshot(record)
    if (!previous) {
      this.emit("tabs", "onCreated", [tab])
    } else {
      const changeInfo: Record<string, unknown> = {}
      if (previous.url !== record.url) changeInfo.url = record.url
      if (previous.title !== record.title) changeInfo.title = record.title
      if (previous.status !== record.status) changeInfo.status = record.status
      if (previous.audible !== record.audible) changeInfo.audible = record.audible
      if (previous.mutedInfo.muted !== record.mutedInfo.muted) changeInfo.mutedInfo = record.mutedInfo
      if (Object.keys(changeInfo).length > 0) this.emit("tabs", "onUpdated", [record.id, changeInfo, tab])
    }
    if (record.active && this.lastActive !== record.id) {
      const previousTabId = this.lastActive
      this.lastActive = record.id
      this.emit("tabs", "onActivated", [{ tabId: record.id, previousTabId, windowId: 1 }])
    }
    for (const listener of this.listeners) listener()
  }

  private removed(tabId: number): void {
    if (!this.records.delete(tabId)) return
    if (this.lastActive === tabId) this.lastActive = undefined
    this.options.onTabRemoved(tabId)
    this.emit("tabs", "onRemoved", [tabId, { windowId: 1, isWindowClosing: false }])
    for (const listener of this.listeners) listener()
  }
}
