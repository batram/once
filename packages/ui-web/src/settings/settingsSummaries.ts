import { customizedCommandCount } from "../keyboard/keybindingStore"
import { getKeybindings } from "../keyboard"
import { DEFAULT_CACHE_MINUTES, parseStorySourceText } from "@once/core"
export function updateSettingsSummaries(
  sectionButtons: ReadonlyMap<string, HTMLButtonElement>,
  sourceFailures: number
): void {
  if (sectionButtons.size === 0) return
  const value = (selector: string) =>
    document.querySelector<HTMLInputElement | HTMLTextAreaElement |
      HTMLSelectElement>(selector)?.value || ""
  const lineCount = (text: string) =>
    text.split("\n").filter((line) => line.trim()).length
  const parsedSources = parseStorySourceText(value("#sources_area"))
  const sourceCount = parsedSources.doc?.sources.length ?? 0
  const filterCount = lineCount(value("#filter_area"))
  const redirectCount = lineCount(value("#redirect_area"))
  const animation = document.querySelector<HTMLInputElement>("#anim_checkbox")
    ?.checked ? "animated" : "still"
  const theme = value("#theme_select") || "system"
  // Only Electron reveals the story-position control, so only Electron's
  // summary carries it.
  const storyPosition =
    document.querySelector<HTMLElement>("#electron_layout_settings")
      ?.hidden === false
      ? value("#electron_story_position") === "browser"
        ? " · below address bar"
        : " · above story list"
      : ""
  const swipeRight = document.querySelector<HTMLSelectElement>(
    '[data-swipe="right-0"]'
  )?.selectedOptions[0]?.textContent || "Read"
  const swipeLeft = document.querySelector<HTMLSelectElement>(
    '[data-swipe="left-0"]'
  )?.selectedOptions[0]?.textContent || "skip"
  const errorRow = sectionButtons.get("errors")
  const errorCount = Number(errorRow?.dataset.errorCount || 0)
  const warningCount = Number(errorRow?.dataset.warningCount || 0)
  const summaries: Record<string, { text: string, error?: boolean }> = {
    sources: {
      text: `${sourceCount}${sourceFailures ? ` · ${sourceFailures} failing` : ""}`,
      error: sourceFailures > 0
    },
    filters: { text: `${filterCount} ${filterCount === 1 ? "keyword" : "keywords"}` },
    redirects: { text: `${redirectCount} ${redirectCount === 1 ? "rule" : "rules"}` },
    sync: {
      text: document.querySelector("#couch_status")?.textContent?.trim() ||
        "Not configured"
    },
    theme: {
      text: `${theme[0]?.toUpperCase()}${theme.slice(1)} · ${animation}` +
        storyPosition
    },
    keyboard: { text: keyboardSummary() },
    swipe: { text: `${swipeRight} · ${swipeLeft}` },
    cache: { text: `${value("#cache_time_input") || DEFAULT_CACHE_MINUTES} min` },
    errors: {
      text: errorCount || warningCount
        ? `${errorCount} error${errorCount === 1 ? "" : "s"} · ` +
          `${warningCount} warning${warningCount === 1 ? "" : "s"}`
        : "No issues",
      error: errorCount > 0
    },
    about: {
      text: document.querySelector("[data-testid='app-version']")
        ?.textContent?.trim() || ""
    }
  }
  for (const [key, summary] of Object.entries(summaries)) {
    const element = sectionButtons.get(key)
      ?.querySelector<HTMLElement>(".settings_section_summary")
    if (!element) continue
    element.textContent = summary.text
    element.classList.toggle(
      "settings_section_summary_error",
      Boolean(summary.error)
    )
  }
}

function keyboardSummary(): string {
  const customized = customizedCommandCount(getKeybindings())
  if (customized === 0) return "Default"
  return `${customized} customised`
}
