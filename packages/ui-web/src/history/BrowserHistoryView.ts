import type { BrowserHistoryPort, BrowserVisit, HistoryPage, HistoryQuery } from "@once/core"

const visitTime = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })

/** A bounded page of visits: the DOM never grows with the user's full history. */
export function mountBrowserHistory(root: HTMLElement, history: Pick<BrowserHistoryPort, "query" | "remove" | "clear">,
  open: (url: string) => void, options: { back?: () => void } = {}): { refresh(): void; dispose(): void } {
  root.classList.add("browser-history")
  root.innerHTML = `<header class="bar toolbar panel_titlebar history-header"><h1>History</h1><button type="button" class="button history-clear">Delete all…</button></header>
    <div class="bar toolbar history-searchbar"><label class="history-search"><span class="icon icon--chrome icon--search" aria-hidden="true"></span><input type="search" aria-label="Search history" placeholder="Search history" autocomplete="off" spellcheck="false"></label></div>
    <div class="history-content"><div class="history-confirm" hidden><p>Delete all browsing history on this device? This cannot be undone.</p><div class="history-confirm-actions"><button type="button" class="button history-cancel">Cancel</button><button type="button" class="button history-confirm-delete">Delete all history</button></div></div>
    <p class="history-status" role="status" aria-live="polite"></p><p class="history-empty-hint" hidden>Pages you open in the browser will be listed here.</p><div class="history-entries"></div>
    <nav class="history-pagination" aria-label="History pages" hidden><button type="button" class="button history-newer" hidden>Newer visits</button><button type="button" class="button history-older" hidden>Older visits</button></nav></div>`
  if (options.back) root.querySelector("header")?.prepend(backButton(options.back))
  const find = <T extends HTMLElement>(selector: string): T => {
    const element = root.querySelector<T>(selector)
    if (!element) throw new Error(`Missing history control: ${selector}`)
    return element
  }
  const search = find<HTMLInputElement>("input")
  const list = find<HTMLElement>(".history-entries")
  const status = find<HTMLElement>(".history-status")
  const hint = find<HTMLElement>(".history-empty-hint")
  const confirm = find<HTMLElement>(".history-confirm")
  const clear = find<HTMLButtonElement>(".history-clear")
  const pagination = find<HTMLElement>(".history-pagination")
  const newer = find<HTMLButtonElement>(".history-newer")
  const older = find<HTMLButtonElement>(".history-older")
  let pages: Array<HistoryQuery["before"]> = [undefined]
  let next: HistoryPage["next"]
  let generation = 0
  let disposed = false
  let busy = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const error = (failure: unknown) => { status.textContent = failure instanceof Error ? failure.message : "Could not load history. Try again." }
  const showPages = (show: boolean) => {
    newer.hidden = !show || pages.length === 1
    older.hidden = !show || !next
    pagination.hidden = newer.hidden && older.hidden
  }

  async function load(reset = false): Promise<void> {
    if (disposed) return
    if (reset) pages = [undefined]
    const current = ++generation
    busy = true
    newer.disabled = older.disabled = true
    list.setAttribute("aria-busy", "true")
    status.textContent = "Loading history…"
    hint.hidden = true
    root.classList.remove("history-empty")
    next = undefined
    try {
      const page = await history.query({ search: search.value, before: pages.at(-1), limit: 50 })
      if (disposed || generation !== current) return
      // A later page emptied by deletions falls back to the one before it
      // rather than showing an empty list that claims there is no history.
      if (!page.entries.length && pages.length > 1) { pages.pop(); return load() }
      next = page.next
      list.replaceChildren()
      let day = ""
      for (const entry of page.entries) {
        const label = new Date(entry.visitedAt).toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" })
        if (label !== day) {
          day = label
          const heading = document.createElement("h2")
          heading.textContent = day
          list.append(heading)
        }
        list.append(historyRow(entry, open, async () => {
          await history.remove(entry.id)
          await load()
          search.focus()
        }, error))
      }
      const empty = !page.entries.length
      const searching = search.value.trim() !== ""
      status.textContent = empty ? searching ? "No matching visits." : "No browsing history yet." : ""
      hint.hidden = !empty || searching
      root.classList.toggle("history-empty", empty)
    } catch (failure) { if (generation === current && !disposed) error(failure) }
    finally {
      if (generation === current && !disposed) {
        busy = false
        list.removeAttribute("aria-busy")
        newer.disabled = older.disabled = false
        showPages(true)
      }
    }
  }

  search.oninput = () => {
    clearTimeout(timer)
    // Immediately invalidate in-flight requests so old results cannot replace a new search.
    generation++
    list.replaceChildren()
    showPages(false)
    timer = setTimeout(() => void load(true), 180)
  }
  clear.onclick = () => { confirm.hidden = false; find<HTMLButtonElement>(".history-cancel").focus() }
  find<HTMLButtonElement>(".history-cancel").onclick = () => { confirm.hidden = true; clear.focus() }
  find<HTMLButtonElement>(".history-confirm-delete").onclick = async event => {
    const button = event.currentTarget as HTMLButtonElement
    button.disabled = true
    try {
      await history.clear()
      confirm.hidden = true
      search.value = ""
      await load(true)
      search.focus()
    } catch (failure) { error(failure) }
    finally { button.disabled = false }
  }
  newer.onclick = () => { if (!busy && pages.length > 1) { pages.pop(); void load() } }
  older.onclick = () => { if (!busy && next) { pages.push(next); void load() } }
  void load()
  return { refresh: () => void load(), dispose: () => { disposed = true; generation++; clearTimeout(timer); root.replaceChildren() } }
}

function backButton(onclick: () => void): HTMLButtonElement {
  const back = document.createElement("button")
  back.type = "button"
  back.className = "button button--icon history-back"
  back.setAttribute("aria-label", "Back")
  back.dataset.testid = "browser_history-panel-close"
  back.innerHTML = '<span class="icon icon--chrome icon--chevron-left" aria-hidden="true"></span>'
  back.onclick = onclick
  return back
}

function historyRow(entry: BrowserVisit, open: (url: string) => void, removeVisit: () => Promise<void>, error: (failure: unknown) => void): HTMLElement {
  const row = document.createElement("div")
  row.className = "history-entry"
  const time = document.createElement("time")
  time.dateTime = new Date(entry.visitedAt).toISOString()
  time.textContent = visitTime.format(new Date(entry.visitedAt))
  const link = document.createElement("a")
  link.href = entry.url
  const title = document.createElement("span")
  title.className = "history-entry-title"
  title.textContent = entry.title || entry.url
  const address = document.createElement("span")
  address.className = "history-entry-url"
  address.textContent = entry.url
  link.title = `${entry.title}\n${entry.url}`
  link.append(title, address)
  link.onclick = event => { event.preventDefault(); open(entry.url) }
  const remove = document.createElement("button")
  remove.type = "button"
  remove.className = "button button--icon history-remove"
  remove.innerHTML = '<span class="icon icon--chrome icon--x" aria-hidden="true"></span>'
  remove.setAttribute("aria-label", `Delete visit to ${entry.title || entry.url}`)
  remove.title = "Delete this visit"
  remove.onclick = async () => {
    remove.disabled = true
    try { await removeVisit() }
    catch (failure) { error(failure); remove.disabled = false }
  }
  row.append(time, link, remove)
  return row
}
