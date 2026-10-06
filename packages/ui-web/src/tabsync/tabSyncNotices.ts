import type { OnceClient, TabSyncView } from "@once/app"
import { continueCandidate, describeTabState } from "@once/core"

const DISMISSED_KEY = "once:continue-dismissed"
const SEEN_KEY = "once:sent-tabs-seen"

/**
 * What tab sync tells the reader without being asked: a tab another device
 * just sent (a toast, and a count on the Tabs entries), and the video or
 * article they were just using elsewhere (the continue banner).
 */
export function mountTabSyncNotices(client: OnceClient): void {
  const host = document.createElement("div")
  host.id = "tab_sync_notices"
  host.className = "tab_sync_notices"
  host.setAttribute("role", "status")
  host.setAttribute("aria-live", "polite")
  document.body.append(host)
  const seen = new Set(readList(SEEN_KEY))
  const dismissed = new Set(readList(DISMISSED_KEY))
  let banner: HTMLElement | null = null
  let revision = 0

  const update = async () => {
    const current = ++revision
    const view = await client.getTabSync().catch(() => null)
    if (current !== revision || !view) return
    showCount(view.inbox.length)
    for (const sent of view.inbox) {
      if (seen.has(sent.id)) continue
      seen.add(sent.id)
      host.append(toast(`${sent.title || sent.url}`, `Sent from ${sent.fromName}`, "sent-tab-toast", [
        ["Open", () => void client.openSentTab(sent.id, false)],
        ["Later", () => undefined]
      ]))
    }
    writeList(SEEN_KEY, [...seen].filter((id) => view.inbox.some((sent) => sent.id === id)))
    showBanner(view)
  }

  const showBanner = (view: TabSyncView) => {
    const candidate = view.options.continueBanner ? continueCandidate(view.devices, view.options, dismissed) : null
    if (banner?.dataset.key === candidate?.key) return
    banner?.remove()
    banner = null
    if (!candidate) return
    const forget = () => {
      dismissed.add(candidate.key)
      writeList(DISMISSED_KEY, [...dismissed].slice(-50))
    }
    banner = toast(`Continue ${candidate.tab.title || candidate.tab.url}`,
      `from ${candidate.deviceName} · ${describeTabState(candidate.tab.state)}`, "continue-banner", [
        ["Open", () => { forget(); client.openRemoteTab(candidate.tab.url, candidate.tab.mode, false, candidate.tab.state) }],
        ["Dismiss", forget]
      ])
    banner.dataset.key = candidate.key
    banner.addEventListener("tab-sync-notice-closed", () => { banner = null })
    host.prepend(banner)
  }

  client.subscribe("tabSyncChanged", () => void update())
  // A snapshot stops being recent while nothing changes, so the banner is re-judged as time passes.
  setInterval(() => void update(), 60_000)
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") void update() })
  void update()
}

type Action = [label: string, run: () => void]

function toast(title: string, detail: string, testid: string, actions: Action[]): HTMLElement {
  const element = document.createElement("div")
  element.className = "tab_sync_notice"
  element.dataset.testid = testid
  const text = document.createElement("div")
  text.className = "tab_sync_notice_text"
  const heading = document.createElement("strong")
  heading.textContent = title
  const line = document.createElement("span")
  line.textContent = detail
  text.append(heading, line)
  element.append(text)
  for (const [label, run] of actions) {
    const button = document.createElement("button")
    button.type = "button"
    button.className = "button"
    button.textContent = label
    button.addEventListener("click", () => {
      run()
      element.remove()
      element.dispatchEvent(new Event("tab-sync-notice-closed"))
    })
    element.append(button)
  }
  return element
}

/** The number of tabs waiting here, on every entry that opens the Tabs list. */
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
