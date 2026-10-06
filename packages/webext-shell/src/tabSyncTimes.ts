import type { LocalWindow, TabSourcePort } from "@once/app"

interface TabTimes { navSeq: number; openedAt: number; navigatedAt: number; selectedAt: number; activityAt: number }
interface TimesState { times: Record<string, TabTimes>; active: Record<string, number> }

const KEY = "once:tabsync:times"

/**
 * When each browser tab was opened, navigated, selected and used, kept in
 * session storage so it survives the background being put to sleep. The
 * browser's own `lastAccessed` covers tabs that were open before Once ran.
 * Also remembers each window's active tab: Chrome's activation event names
 * only the new tab, and the one being left is what state capture needs.
 */
export function installTabSyncTimes(api: typeof browser): TabSourcePort {
  const storage = api.storage.session
  let queue: Promise<unknown> = Promise.resolve()
  const listeners = new Set<() => void>()
  const deselected = new Set<(tabId: string) => void>()
  const changed = () => listeners.forEach((listener) => listener())
  const update = (change: (state: TimesState, now: number) => void | Promise<void>) => {
    queue = queue.then(async () => {
      const state = ((await storage.get(KEY))[KEY] as TimesState | undefined) ?? { times: {}, active: {} }
      await change(state, Date.now())
      await storage.set({ [KEY]: state })
    }).catch((error) => console.error("Unable to track tab times", error))
    void queue.then(changed)
  }
  const entry = (state: TimesState, tabId: number, now: number): TabTimes =>
    (state.times[tabId] ??= { navSeq: 0, openedAt: now, navigatedAt: now, selectedAt: now, activityAt: now })

  api.tabs.onCreated.addListener((tab) => {
    if (tab.id !== undefined) update((state, now) => { entry(state, tab.id as number, now) })
  })
  api.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId !== 0) return
    update((state, now) => {
      const times = entry(state, details.tabId, now)
      times.navSeq++
      times.navigatedAt = times.activityAt = now
    })
  })
  // Chrome names only the newly selected tab; the one left comes from the
  // window's last known selection, kept across the background's sleep.
  api.tabs.onActivated.addListener(({ tabId, windowId }) => {
    let left: number | undefined
    update((state, now) => {
      const times = entry(state, tabId, now)
      times.selectedAt = times.activityAt = now
      left = state.active[windowId]
      state.active[windowId] = tabId
    })
    void queue.then(() => { if (left !== undefined && left !== tabId) deselected.forEach((listener) => listener(String(left))) })
  })
  api.tabs.onRemoved.addListener((tabId) => {
    update((state) => {
      state.times = Object.fromEntries(Object.entries(state.times).filter(([id]) => id !== String(tabId)))
      state.active = Object.fromEntries(Object.entries(state.active).filter(([, active]) => active !== tabId))
    })
  })
  api.tabs.onUpdated.addListener((_tabId, change) => {
    if (change.title !== undefined || change.audible !== undefined || change.pinned !== undefined) changed()
  })
  // Reconcile existing tabs at startup and after cross-window moves. Queue this
  // with events so a slow browser query cannot overwrite a newer activation.
  const reconcile = () => update(async (state) => {
    const windows = await api.windows.getAll({ populate: true, windowTypes: ["normal"] })
    state.active = Object.fromEntries(windows.flatMap((window) => {
      const active = window.tabs?.find((tab) => tab.active)
      return active?.id === undefined ? [] : [[String(window.id), active.id]]
    }))
    const open = new Set(windows.flatMap((window) => (window.tabs ?? []).map((tab) => String(tab.id))))
    state.times = Object.fromEntries(Object.entries(state.times).filter(([id]) => open.has(id)))
  })
  for (const event of [api.tabs.onAttached, api.tabs.onDetached, api.windows.onRemoved]) {
    (event as { addListener(listener: () => void): void }).addListener(reconcile)
  }
  api.windows.onFocusChanged.addListener(changed)
  reconcile()

  return {
    async snapshot(): Promise<LocalWindow[]> {
      await queue
      const state = ((await storage.get(KEY))[KEY] as TimesState | undefined) ?? { times: {}, active: {} }
      const windows = await api.windows.getAll({ populate: true, windowTypes: ["normal"] })
      return windows.map((window) => ({
        id: String(window.id), focused: window.focused, incognito: window.incognito,
        tabs: (window.tabs ?? []).flatMap((tab) => {
          if (tab.id === undefined || !tab.url) return []
          const accessed = (tab as { lastAccessed?: number }).lastAccessed ?? 0
          const times = state.times[tab.id] ?? { navSeq: 0, openedAt: accessed, navigatedAt: accessed, selectedAt: accessed, activityAt: accessed }
          return [{
            id: String(tab.id), url: tab.url, title: tab.title ?? "", mode: "web" as const,
            active: tab.active, pinned: tab.pinned, audible: tab.audible ?? false, ...times
          }]
        })
      }))
    },
    onChanged(handler) {
      listeners.add(handler)
      return () => listeners.delete(handler)
    },
    onDeselected(handler) {
      deselected.add(handler)
      return () => deselected.delete(handler)
    },
    async runInPage(tabId, call) {
      const tab = await api.tabs.get(Number(tabId)).catch(() => null)
      if (!tab?.url || !/^https?:/.test(tab.url)) return null
      const [result] = await api.scripting.executeScript({
        target: { tabId: Number(tabId) },
        func: call.fn as unknown as (...args: unknown[]) => void,
        args: call.args
      }).catch(() => [])
      return (result?.result ?? null) as never
    }
  }
}
