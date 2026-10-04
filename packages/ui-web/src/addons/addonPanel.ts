// The Once panel as a place for a page's add-on conversation: beside the page
// it is about, rather than in a tab that covers it. Chosen per add-on in its
// settings, it is mostly reached from a page's context menu. The panel and its
// menu button exist only while a conversation is shown there, and go away
// when it is closed or the conversation ends.
import { TemporaryPanel } from "../shell/temporaryPanel"
import type { OnceClient } from "@once/app"
import type { AddonConversationSnapshot } from "@once/core"
import type { AddonConversationHandle, AddonConversationSurface } from "./AddonTrays"
import { AddonConversationPort, mountAddonConversation } from "./conversationPage"
import { PAGE_ADDON_ACTIONS_CHANGED, isAddonPage, pageAddonActions, pageSourceUrl, runPageAddonAction } from "./pageAddons"
import { trayButton } from "./trayMessages"

/** The `active_panel` name of the add-on conversation panel. */
export const ADDON_PANEL = "addon"

/**
 * The add-on as its menu button names it: the short name it declares, its name
 * when that fits, or the initials of a longer one ("What? Wait, who, why?" is WWWW).
 */
export function menuName(addon: { name: string; shortName?: string }): string {
  if (addon.shortName) return addon.shortName
  if (addon.name.length <= 12) return addon.name
  return (addon.name.match(/[\p{L}\p{N}]+/gu) ?? []).map(word => word[0].toUpperCase()).join("").slice(0, 6) || addon.name.slice(0, 12)
}

type Entry = { handle: AddonConversationHandle; release: () => void }
type Shown = { panel: TemporaryPanel; unmount: () => void; key: string; context: HTMLElement; history: HTMLSelectElement; subject: string; related: boolean; comments: boolean }

/** Reuse the browser's row only when it is also this conversation's subject. */
function syncStoryMirror(shown: Shown | null): void {
  const row = document.querySelector<HTMLElement>("#stories_panel #selected_container story-item")
  const matches = Boolean(shown?.related && row?.dataset.href === shown.subject && document.body.dataset.electronStoryPosition !== "browser")
  document.querySelector<HTMLElement>("#left_panel")?.setAttribute("data-addon-story-matched", String(matches))
  if (shown) shown.context.hidden = matches && !shown.comments
}

function conversationPort(handle: AddonConversationHandle): AddonConversationPort {
  return {
    subscribe(listener) {
      listener(handle.snapshot(), true)
      return handle.subscribe(snapshot => listener(snapshot, true))
    },
    send: command => handle.send(command)
  }
}

function updateRecent(shown: Shown | null, recent: Map<string, Entry>): void {
  if (!shown) return
  const placeholder = document.createElement("option")
  placeholder.value = ""
  placeholder.textContent = "Recent"
  placeholder.disabled = true
  shown.history.replaceChildren(placeholder, ...Array.from(recent, ([key, entry]) => {
    const snapshot = entry.handle.snapshot()
    const option = document.createElement("option")
    option.value = key
    const tool = snapshot.tray.title === snapshot.addon.name ? menuName(snapshot.addon) : `${menuName(snapshot.addon)} · ${snapshot.tray.title}`
    option.textContent = `${snapshot.story.title} · ${tool}`
    return option
  }))
  shown.history.value = ""
  shown.history.hidden = recent.size < 2
}

function restoreFocus(opener: HTMLElement | null): void {
  const previous = document.querySelector("#left_panel")?.getAttribute("active_panel")
  const menu = document.querySelector<HTMLElement>(`#${previous}_menu_btn`)
  const fallback = menu?.matches("button") ? menu : menu?.querySelector<HTMLElement>("button.heading")
  const target = opener?.isConnected && !opener.closest("[hidden]") && opener.getClientRects().length ? opener : fallback
  target?.focus()
}

/** Replace old navigation controls immediately, before resolving the new page. */
function subjectHeader(context: HTMLElement, snapshot: AddonConversationSnapshot, client: Pick<OnceClient, "openUrl">): HTMLElement {
  const subject = document.createElement("a")
  subject.className = "addon_panel_subject"
  subject.textContent = snapshot.story.title
  subject.href = snapshot.story.href
  subject.title = snapshot.story.href
  subject.addEventListener("click", event => { event.preventDefault(); client.openUrl(snapshot.story.href, event.ctrlKey || event.metaKey ? "middle" : "current") })
  const address = document.createElement("small")
  address.textContent = new URL(snapshot.story.href).hostname
  const buttons = document.createElement("div")
  buttons.className = "addon_tray_actions"
  context.replaceChildren(subject, address, buttons)
  return buttons
}

/** Shows page conversations in the Once panel; the surface `mountAddons` opens the panel choice with. */
export function addonPanelConversations(client: Pick<OnceClient, "subscribe" | "findStoryByUrl" | "openUrl">): AddonConversationSurface {
  const recent = new Map<string, Entry>()
  let currentUrl = ""
  let request = 0
  let opener: HTMLElement | null = null
  let shown: Shown | null = null
  const keyOf = (handle: AddonConversationHandle): string => {
    const snapshot = handle.snapshot()
    return JSON.stringify([snapshot.addon.id, snapshot.tray.id, snapshot.story.href])
  }
  const focusTitle = (): void => { shown?.panel.title.focus() }
  const close = (): void => {
    if (!shown) return
    const active = document.querySelector("#left_panel")?.getAttribute("active_panel") === ADDON_PANEL
    const { panel, unmount } = shown
    shown = null
    request++
    unmount()
    panel.remove()
    syncStoryMirror(null)
    if (active) restoreFocus(opener)
  }
  const updateHistory = (): void => updateRecent(shown, recent)
  const updateContext = async (): Promise<void> => {
    const current = shown
    if (!current) return
    const entry = recent.get(current.key)
    if (!entry) return
    const snapshot = entry.handle.snapshot()
    const revision = ++request
    const href = pageSourceUrl(currentUrl)
    const actions = [...pageAddonActions("menu"), ...pageAddonActions("button")]
    const action = actions.find(item => item.id.startsWith(`addon:${snapshot.addon.id}/`) && item.tray === snapshot.tray.id)
    const title = snapshot.tray.title === snapshot.addon.name ? snapshot.addon.name : `${snapshot.addon.name} · ${snapshot.tray.title}`
    current.panel.label(action?.icon ?? "link", menuName(snapshot.addon), title)
    current.related = false
    current.comments = false
    syncStoryMirror(current)
    const buttons = subjectHeader(current.context, snapshot, client)
    const [subjectStory, pageStory] = await Promise.all([
      client.findStoryByUrl(snapshot.story.href).catch(() => null),
      href ? client.findStoryByUrl(href).catch(() => null) : Promise.resolve(null)
    ])
    if (revision !== request || shown !== current) return
    const comments = subjectStory?.matches_comment_url(href) === true
    const related = href === snapshot.story.href || subjectStory?.matches_url(href) === true || pageStory?.href === snapshot.story.href
    current.related = related
    current.comments = comments
    syncStoryMirror(current)
    if (!related || comments) buttons.append(trayButton("Open article", () => client.openUrl(snapshot.story.href, "current")))
    const applicable = [...pageAddonActions("menu", { href }), ...pageAddonActions("button", { href })]
      .find(item => item.id === action?.id)
    if (!related && isAddonPage(href) && applicable) {
      buttons.append(trayButton("Use current page", () => {
        runPageAddonAction(applicable.id, { href, title: pageStory?.title }, "panel")
      }))
    }
  }
  client.subscribe("selectedUrlChanged", ({ url }) => { currentUrl = url; void updateContext() })
  document.addEventListener(PAGE_ADDON_ACTIONS_CHANGED, () => { void updateContext() })
  const observer = new MutationObserver(() => syncStoryMirror(shown))
  const mirror = document.getElementById("selected_container")
  if (mirror) observer.observe(mirror, { childList: true })
  observer.observe(document.body, { attributes: true, attributeFilter: ["data-electron-story-position"] })
  const surface: AddonConversationSurface = {
    label: "Show in the Once panel",
    open(handle) {
      const key = keyOf(handle)
      if (shown?.key === key) { shown.panel.show(); focusTitle(); return }
      const focused = document.activeElement
      if (focused instanceof HTMLElement && focused !== document.body && !focused.closest("#addon_panel, #addon_panel_bar")) opener = focused
      if (!recent.has(key)) {
        const entry: Entry = { handle, release: () => undefined }
        recent.set(key, entry)
        entry.release = handle.subscribe(snapshot => {
          if (snapshot) return
          recent.delete(key)
          entry.release()
          // A late reset notification must not close a replacement conversation.
          queueMicrotask(() => { if (shown?.key === key && !recent.has(key)) close(); else updateHistory() })
        })
        if (recent.size > 12) {
          const oldest = recent.keys().next().value as string
          recent.get(oldest)?.release()
          recent.delete(oldest)
        }
      }
      // One conversation at a time: a new one takes the place of the last.
      shown?.unmount()
      const panel = shown?.panel ?? TemporaryPanel.create(ADDON_PANEL, close)
      if (!panel) return
      panel.title.id = "addon_panel_title"
      panel.title.tabIndex = -1
      panel.title.setAttribute("role", "heading")
      panel.title.setAttribute("aria-level", "2")
      panel.panel.setAttribute("role", "region")
      panel.panel.setAttribute("aria-labelledby", panel.title.id)
      panel.button.onclick = focusTitle
      const context = document.createElement("div")
      context.className = "addon_panel_context"
      const history = document.createElement("select")
      history.className = "addon_panel_history"
      history.setAttribute("aria-label", "Recent conversations")
      history.addEventListener("change", () => { const next = recent.get(history.value); if (next) surface.open(next.handle); history.value = "" })
      panel.panel.querySelector(".addon_panel_context")?.remove()
      panel.bar.querySelector("select")?.remove()
      panel.panel.prepend(context)
      panel.bar.insertBefore(history, panel.bar.lastElementChild)
      shown = { panel, key, context, history, subject: handle.snapshot().story.href, related: false, comments: false,
        unmount: mountAddonConversation(panel.body, conversationPort(handle), true) }
      updateHistory()
      void updateContext()
      panel.show()
      focusTitle()
    }
  }
  return surface
}
