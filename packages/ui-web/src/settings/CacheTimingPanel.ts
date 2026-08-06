/**
 * The cache section below the global cache-timing field: a window per
 * collector, and a row per source saying when it last fetched.
 *
 * It lives beside `#cache_time_input` inside the one `.settings_block` the
 * section already owns, because `installSettingsNavigation` treats a block as
 * one unit. It deliberately does not use `.structured_settings`, which settings
 * search strips out of its index — these rows are worth finding.
 */

import { OnceClient, SourceCacheStatus } from "@once/app"
import { get_active } from "@once/collectors"
import { humanTime, readCacheMinutesInput } from "@once/core"
import { reportSettingsStatus, trackSettingsSave } from "./settingsStatus"

const HOST_ID = "cache_timing_panel"
const ROWS_ID = "cache_timing_rows"

export class CacheTimingPanel {
  private subscribed = false

  constructor(private readonly client: OnceClient) {}

  /**
   * Rebuilds the rows. Called whenever the section is restored and whenever
   * something changes what the cache holds, so the timestamps are never older
   * than the panel the user is looking at.
   */
  async refresh(): Promise<void> {
    const host = this.mount()
    if (!host) return
    const [timing, globalMinutes, status] = await Promise.all([
      this.client.getCacheTiming(),
      this.client.getCacheTime(),
      this.client.getSourceCacheStatus()
    ])
    this.renderCollectorRows(timing.collectors, globalMinutes)
    host.textContent = ""
    host.append(
      heading("Cached feeds"),
      this.sourceRows(status),
      this.clearButton()
    )
  }

  private mount(): HTMLElement | undefined {
    const host = document.getElementById(HOST_ID)
    if (!host) return undefined
    if (!this.subscribed) {
      this.subscribed = true
      this.client.subscribe("cacheStatusChanged", () => void this.refresh())
    }
    return host
  }

  /**
   * Collectors are further rows of the list the markup starts, whose first row
   * is the default window. Only the generated rows are replaced: the default
   * row is shell markup, because the section is resolved by that control's id
   * before this panel has rendered anything.
   */
  private renderCollectorRows(
    overrides: Record<string, number>,
    globalMinutes: number
  ): void {
    const list = document.getElementById(ROWS_ID)
    if (!list) return
    list.querySelectorAll("[data-collector]").forEach((row) => row.remove())
    for (const collector of get_active()) {
      const { id, description, cache_minutes: shipped } = collector.options
      const row = document.createElement("label")
      row.className = "cache_timing_row field"
      const name = document.createElement("span")
      name.className = "field_label"
      // Labelled by description: both Reddit collectors carry the badge "re",
      // so the badge cannot tell one row from the other.
      name.textContent = description
      const input = document.createElement("input")
      input.type = "text"
      input.className = "cache_timing_input"
      input.dataset.collector = id
      input.dataset.testid = `cache-timing-${id}`
      input.inputMode = "numeric"
      input.value = overrides[id] === undefined ? "" : String(overrides[id])
      // The inherited value is shown as a placeholder, so an empty field still
      // says what will happen without claiming the user chose it.
      input.placeholder = String(shipped ?? globalMinutes)
      input.addEventListener("change", () => void this.saveCollector(input))
      row.append(name, input)
      row.dataset.collector = id
      list.append(row)
    }
  }

  private async saveCollector(input: HTMLInputElement): Promise<void> {
    const id = input.dataset.collector
    if (!id) return
    const parsed = readCacheMinutesInput(input.value)
    if (!parsed.ok) {
      input.setAttribute("aria-invalid", "true")
      reportSettingsStatus(input, "failed")
      return
    }
    input.removeAttribute("aria-invalid")
    await trackSettingsSave(input, async () => {
      const timing = await this.client.getCacheTiming()
      // Rebuilt without the row key rather than deleted from a copy: blank
      // means "no override", which is an absent entry, not a stored zero.
      const collectors = Object.fromEntries(
        Object.entries(timing.collectors).filter(([key]) => key !== id)
      )
      if (parsed.minutes !== undefined) collectors[id] = parsed.minutes
      await this.client.setCacheTiming({ ...timing, collectors })
    })
  }

  private sourceRows(status: SourceCacheStatus[]): HTMLElement {
    const list = document.createElement("div")
    list.className = "cache_source_rows stack"
    list.dataset.testid = "cache-source-rows"
    if (!status.length) {
      const empty = document.createElement("p")
      empty.className = "settings_description"
      empty.textContent = "No story sources yet."
      list.append(empty)
      return list
    }
    for (const source of status) {
      list.append(this.sourceRow(source))
    }
    return list
  }

  private sourceRow(source: SourceCacheStatus): HTMLElement {
    const row = document.createElement("div")
    row.className = "cache_source_row row"
    // Not `data-source-id`: that attribute means "a row in the sources editor",
    // and the error log clicks it by id from anywhere in the panel.
    row.dataset.cacheSourceId = source.sourceId
    const name = document.createElement("span")
    name.className = "cache_source_name"
    name.textContent = source.name
    name.title = source.url
    const meta = document.createElement("span")
    meta.className = "cache_source_meta"
    meta.textContent = describeWindow(source)
    const refetch = document.createElement("button")
    refetch.type = "button"
    refetch.className = "button"
    refetch.textContent = "Refetch now"
    refetch.dataset.testid = `refetch-${source.sourceId}`
    refetch.addEventListener("click", () => {
      refetch.disabled = true
      // No delete first: another source may share this URL, and the fetch
      // replaces the entry anyway.
      void this.client.refetchSource(source.sourceId).finally(() => {
        refetch.disabled = false
      })
    })
    row.append(name, meta, refetch)
    return row
  }

  private clearButton(): HTMLElement {
    const actions = document.createElement("div")
    actions.className = "settings_actions cluster"
    const clear = document.createElement("button")
    clear.type = "button"
    clear.className = "button"
    clear.id = "clear_cached_feeds"
    clear.dataset.testid = "clear-cached-feeds"
    clear.textContent = "Clear cached feeds"
    clear.addEventListener("click", () => {
      clear.disabled = true
      void this.client.clearCachedFeeds().finally(() => {
        clear.disabled = false
      })
    })
    actions.append(clear)
    return actions
  }

}

function describeWindow(source: SourceCacheStatus): string {
  const policy = source.cacheMinutes === 0
    ? "always refetch"
    : `${source.cacheMinutes} min${source.ownWindow ? "" : " (inherited)"}`
  const fetched = source.fetchedAt === undefined
    ? "not cached"
    : `fetched ${humanTime(source.fetchedAt)}`
  return `${policy} · ${fetched}`
}

function heading(text: string): HTMLElement {
  const element = document.createElement("h4")
  element.className = "settings_subheading"
  element.textContent = text
  return element
}
