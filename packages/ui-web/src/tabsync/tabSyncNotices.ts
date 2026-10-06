import type { OnceClient, SentTabView, TabSyncView } from "@once/app"
import { continueCandidate, describeTabState } from "@once/core"

const DISMISSED_KEY = "once:continue-dismissed"
const SEEN_KEY = "once:sent-tabs-seen"
/** How long a notice stays before it gets out of the way; the tab stays listed. */
const NOTICE_MS = 12_000

export interface TabSyncNoticeOptions {
  /** Where the notices dock: the bottom of the side panel by default. */
  dock?: HTMLElement
  /** Shows the list of tabs sent here, for a notice about several. */
  showTabs?: () => void
  /** A system notification for a tab sent here while the window is in the background (Electron). */
  systemNotifications?: boolean
}

interface Notice {
  key: string
  testid: string
  title: string
  detail: string
  action: [label: string, run: () => void]
  /** The notice went away by itself or by its ×. */
  closed?: () => void
}

/**
 * What tab sync tells the reader without being asked, one thing at a time:
 * tabs another device just sent (a notice, and a count on the entries that
 * list them), else the video or article just used elsewhere (the continue
 * offer). A notice leaves after a few seconds; what it was about stays in
 * the tabs list.
 */
export function mountTabSyncNotices(client: OnceClient, options: TabSyncNoticeOptions = {}): void {
  const dock = document.createElement("div")
  dock.id = "tab_sync_notices"
  dock.className = "tab_sync_dock"
  dock.setAttribute("role", "status")
  dock.setAttribute("aria-live", "polite")
  ;(options.dock ?? document.querySelector("#left_main") ?? document.body).append(dock)
  const showTabs = options.showTabs ?? (() => document.querySelector<HTMLElement>("#tabs_menu_btn:not([hidden])")?.click())
  const seen = new Set(readList(SEEN_KEY))
  const dismissed = new Set(readList(DISMISSED_KEY))
  let shown: { key: string; element: HTMLElement; timer?: ReturnType<typeof setTimeout> } | null = null
  const notified = new Set<string>()
  let revision = 0

  const close = () => {
    if (!shown) return
    clearTimeout(shown.timer)
    shown.element.remove()
    shown = null
  }

  const show = (notice: Notice) => {
    if (shown?.key === notice.key) return
    close()
    const element = noticeElement(notice, () => { notice.closed?.(); close(); void update() })
    const entry: { key: string; element: HTMLElement; timer?: ReturnType<typeof setTimeout> } = { key: notice.key, element }
    shown = entry
    const leave = () => { notice.closed?.(); if (shown === entry) close(); void update() }
    const arm = () => { clearTimeout(entry.timer); entry.timer = setTimeout(leave, NOTICE_MS) }
    // A notice being read or reached by keyboard stays until it is left.
    element.addEventListener("pointerenter", () => clearTimeout(entry.timer))
    element.addEventListener("pointerleave", arm)
    element.addEventListener("focusin", () => clearTimeout(entry.timer))
    element.addEventListener("focusout", arm)
    arm()
    dock.append(element)
  }

  const markSeen = (inbox: SentTabView[]) => {
    for (const sent of inbox) seen.add(sent.id)
    writeList(SEEN_KEY, [...seen].filter((id) => inbox.some((sent) => sent.id === id)))
  }

  const update = async () => {
    const current = ++revision
    const view = await client.getTabSync().catch(() => null)
    if (current !== revision || !view) return
    showCount(view.inbox.length)
    const fresh = view.inbox.filter((sent) => !seen.has(sent.id))
    const unannounced = fresh.filter((sent) => !notified.has(sent.id))
    if (unannounced.length && options.systemNotifications && !document.hasFocus()) notifySystem(client, unannounced)
    for (const sent of fresh) notified.add(sent.id)
    const next = fresh.length ? sentNotice(client, fresh, showTabs, () => markSeen(view.inbox))
      : continueNotice(client, view, dismissed)
    // Nothing left to say: opened elsewhere, no longer recent, or turned off.
    if (next) show(next)
    else close()
  }

  client.subscribe("tabSyncChanged", () => void update())
  // A snapshot stops being recent while nothing changes, so the offer is re-judged as time passes.
  setInterval(() => void update(), 60_000)
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") void update() })
  void update()
}

function sentNotice(client: OnceClient, fresh: SentTabView[], showTabs: () => void, seen: () => void): Notice {
  const key = `sent:${fresh.map((sent) => sent.id).join(",")}`
  if (fresh.length === 1) {
    const [sent] = fresh
    return {
      key, testid: "sent-tab-toast", title: sent.title || sent.url,
      detail: [`Sent from ${sent.fromName}`, ...(describeTabState(sent.state) ? [describeTabState(sent.state)] : [])].join(" · "),
      action: ["Open", () => { seen(); void client.openSentTab(sent.id, false) }],
      closed: seen
    }
  }
  const senders = [...new Set(fresh.map((sent) => sent.fromName))]
  return {
    key, testid: "sent-tab-toast", title: `${fresh.length} tabs sent to this device`,
    detail: `From ${senders.join(" and ")}`,
    action: ["Show", () => { seen(); showTabs() }],
    closed: seen
  }
}

function continueNotice(client: OnceClient, view: TabSyncView, dismissed: Set<string>): Notice | null {
  const candidate = view.options.enabled && view.options.continueBanner
    ? continueCandidate(view.devices, view.options, dismissed) : null
  if (!candidate) return null
  const forget = () => {
    dismissed.add(candidate.key)
    writeList(DISMISSED_KEY, [...dismissed].slice(-50))
  }
  return {
    key: `continue:${candidate.key}`, testid: "continue-banner",
    title: `Continue “${candidate.tab.title || candidate.tab.url}”`,
    detail: [candidate.deviceName, ...(describeTabState(candidate.tab.state) ? [describeTabState(candidate.tab.state)] : [])].join(" · "),
    action: ["Continue", () => { forget(); client.openRemoteTab(candidate.tab.url, candidate.tab.mode, false, candidate.tab.state) }],
    closed: forget
  }
}

function noticeElement(notice: Notice, dismiss: () => void): HTMLElement {
  const element = document.createElement("div")
  element.className = "tab_sync_notice"
  element.dataset.testid = notice.testid
  const text = document.createElement("div")
  text.className = "tab_sync_notice_text"
  const heading = document.createElement("strong")
  heading.className = "tab_sync_notice_title"
  heading.textContent = notice.title
  const line = document.createElement("span")
  line.className = "tab_sync_notice_detail"
  line.textContent = notice.detail
  text.append(heading, line)
  const [label, run] = notice.action
  const action = document.createElement("button")
  action.type = "button"
  action.className = "button tab_sync_notice_action"
  action.textContent = label
  action.addEventListener("click", () => {
    run()
    element.remove()
    dismiss()
  })
  const close = document.createElement("button")
  close.type = "button"
  close.className = "button button--icon tab_sync_notice_close"
  close.setAttribute("aria-label", "Close")
  close.title = "Close"
  const icon = document.createElement("span")
  icon.className = "icon icon--chrome icon--x"
  icon.setAttribute("aria-hidden", "true")
  close.append(icon)
  close.addEventListener("click", dismiss)
  element.append(text, action, close)
  return element
}

/** The desktop app in the background still hears about a tab sent to it. */
function notifySystem(client: OnceClient, fresh: SentTabView[]): void {
  if (typeof Notification === "undefined" || Notification.permission === "denied") return
  for (const sent of fresh) {
    const notification = new Notification(`Tab from ${sent.fromName}`, { body: sent.title || sent.url, tag: `once-sent-${sent.id}` })
    notification.addEventListener("click", () => {
      window.focus()
      void client.openSentTab(sent.id, false)
    })
  }
}

/** The number of tabs waiting here, on every entry that opens the tabs list. */
function showCount(count: number): void {
  for (const entry of document.querySelectorAll<HTMLElement>("#tabs_menu_btn, #tab_sync_btn, #reading_tabs")) {
    if (count) entry.dataset.sentCount = String(count)
    else delete entry.dataset.sentCount
  }
}

function readList(key: string): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "[]")
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
  } catch {
    return []
  }
}

function writeList(key: string, values: string[]): void {
  try { localStorage.setItem(key, JSON.stringify(values)) } catch { /* remembered for this session only */ }
}
