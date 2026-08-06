/**
 * The rows of the cache section: a window per collector, and a row per source
 * saying when it last fetched.
 *
 * The section markup owns the two groups, the default-window row and the clear
 * action; this fills them in. Structure that must exist before the panel first
 * renders cannot be generated here — the section is resolved by
 * `#cache_time_input` while SettingsPanel is still constructing.
 *
 * It deliberately does not use `.structured_settings`, which settings search
 * strips out of its index — these rows are worth finding.
 */

import { OnceClient, SourceCacheStatus } from "@once/app"
import { get_active } from "@once/collectors"
import { humanTime, readCacheMinutesInput } from "@once/core"
import { reportSettingsStatus, trackSettingsSave } from "./settingsStatus"

const HOST_ID = "cache_timing_panel"
const ROWS_ID = "cache_timing_rows"

export interface CacheTimingPanelActions {
  /** Opens the sources section on one source, for editing its own window. */
  showSource(sourceId: string): void
}

export class CacheTimingPanel {
  private subscribed = false

  constructor(
    private readonly client: OnceClient,
    private readonly actions: CacheTimingPanelActions
  ) {}

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
    host.append(this.sourceRows(status))
  }

  private mount(): HTMLElement | undefined {
    const host = document.getElementById(HOST_ID)
    if (!host) return undefined
    if (!this.subscribed) {
      this.subscribed = true
      this.client.subscribe("cacheStatusChanged", () => void this.refresh())
      this.bindClear()
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
      name.className = "cache_timing_name"
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

    // The name is both the subject of the row and the way to its own window,
    // which lives on the source rather than here.
    const name = document.createElement("button")
    name.type = "button"
    name.className = "cache_source_name"
    name.textContent = source.name
    name.title = `${source.url}\nEdit this source`
    name.dataset.testid = `cache-source-${source.sourceId}`
    name.addEventListener("click", () =>
      this.actions.showSource(source.sourceId))

    const policy = document.createElement("span")
    policy.className = "cache_source_window"
    policy.textContent = source.cacheMinutes === 0
      ? "always"
      : `${source.cacheMinutes} min`
    if (!source.ownWindow) {
      policy.classList.add("cache_source_inherited")
      policy.title = "Inherited from the collector or the default"
    }

    const fetched = document.createElement("span")
    fetched.className = "cache_source_fetched"
    fetched.textContent = source.fetchedAt === undefined
      ? "never"
      : humanTime(source.fetchedAt)

    const refetch = document.createElement("button")
    refetch.type = "button"
    refetch.className = "button"
    refetch.textContent = "Refetch"
    refetch.dataset.testid = `refetch-${source.sourceId}`
    refetch.addEventListener("click", () => {
      refetch.disabled = true
      // No delete first: another source may share this URL, and the fetch
      // replaces the entry anyway.
      void this.client.refetchSource(source.sourceId).finally(() => {
        refetch.disabled = false
      })
    })

    row.append(name, policy, fetched, refetch)
    return row
  }

  /** The action is section markup; only its behaviour belongs here. */
  private bindClear(): void {
    const clear = document.getElementById("clear_cached_feeds")
    if (!(clear instanceof HTMLButtonElement)) return
    clear.addEventListener("click", () => {
      clear.disabled = true
      void this.client.clearCachedFeeds().finally(() => {
        clear.disabled = false
      })
    })
  }

}


