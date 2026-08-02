export interface SettingsSearchMatch {
  text: string
  controlId?: string
  targetId?: string
  startIndex?: number
  endIndex?: number
}

export interface SettingsSearchResult {
  matches: SettingsSearchMatch[]
  totalMatches: number
}

interface SearchSegment extends SettingsSearchMatch {
  searchText: string
}

export const MAX_SETTINGS_MATCHES = 8

const normalize = (value: string): string =>
  value.replace(/\s+/g, " ").trim()

const normalizedLower = (value: string): string =>
  normalize(value).toLocaleLowerCase()

const addSegment = (
  segments: SearchSegment[],
  value: string | null | undefined,
  location: Omit<SettingsSearchMatch, "text"> = {}
): void => {
  const text = normalize(value || "")
  if (!text) return
  const duplicate = segments.some((segment) =>
    segment.text === text &&
    segment.controlId === location.controlId &&
    segment.targetId === location.targetId &&
    segment.startIndex === location.startIndex
  )
  if (!duplicate) segments.push({ text, searchText: normalizedLower(text), ...location })
}

const excerpt = (segment: string, query: string): string => {
  const maxLength = 72
  if (segment.length <= maxLength) return segment

  const index = normalizedLower(segment).indexOf(query)
  const start = Math.max(0, index - 24)
  const end = Math.min(segment.length, start + maxLength)
  return `${start > 0 ? "…" : ""}${segment.slice(start, end).trim()}${
    end < segment.length ? "…" : ""
  }`
}

export function settingsSearchSegments(section: HTMLElement): SearchSegment[] {
  const segments: SearchSegment[] = []
  const copy = section.cloneNode(true) as HTMLElement

  // The sync field may contain credentials. Exclude its complete presentation,
  // including masking and connection-status layers, from the search document.
  copy
    .querySelectorAll(
      ".couch-container, #couch_input, #couch_status, .highlights, .backdrop, " +
      ".structured_settings"
    )
    .forEach((element) => {
      element.remove()
    })

  if (section.ownerDocument.body.dataset.platform !== "mobile") {
    copy.querySelectorAll(".swipe_mobile_only").forEach((element) => {
      element.remove()
    })
  }

  for (const element of [copy, ...copy.querySelectorAll<HTMLElement>("*")]) {
    if (element.matches("textarea, input, select")) continue
    const targetId =
      element.closest<HTMLElement>(".error_log_entry")?.id || undefined
    const location = { targetId }
    const directText = Array.from(element.childNodes)
      .filter((node) => node.nodeType === 3)
      .map((node) => node.textContent || "")
      .join(" ")
    addSegment(segments, directText, location)
    addSegment(segments, element.getAttribute("aria-label"), location)
    addSegment(segments, element.getAttribute("title"), location)
    addSegment(segments, element.getAttribute("placeholder"), location)
  }

  section
    .querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
      "input, textarea, select"
    )
    .forEach((control) => {
      if (control.id === "couch_input" || control.closest(".couch-container")) {
        return
      }
      if (control instanceof HTMLTextAreaElement) {
        let lineStart = 0
        for (const line of control.value.split("\n")) {
          addSegment(segments, line, {
            controlId: control.id || undefined,
            startIndex: lineStart,
            endIndex: lineStart + line.length
          })
          lineStart += line.length + 1
        }
        return
      }
      if (control instanceof HTMLSelectElement) {
        addSegment(
          segments,
          control.selectedOptions?.[0]?.textContent ||
            control.options[control.selectedIndex]?.textContent,
          { controlId: control.id || undefined }
        )
        addSegment(segments, control.value, {
          controlId: control.id || undefined
        })
        return
      }
      if (control instanceof HTMLInputElement &&
          (control.type === "checkbox" || control.type === "radio")) {
        addSegment(
          segments,
          control.checked ? "checked enabled on" : "unchecked disabled off",
          { controlId: control.id || undefined }
        )
        return
      }
      addSegment(segments, control.value, {
        controlId: control.id || undefined,
        startIndex: 0,
        endIndex: control.value.length
      })
    })

  return segments
}

export function matchSettingsSection(
  section: HTMLElement,
  label: string,
  rawQuery: string
): SettingsSearchResult | null {
  const query = normalizedLower(rawQuery)
  if (!query) return { matches: [], totalMatches: 0 }
  if (normalizedLower(label).includes(query)) {
    return { matches: [], totalMatches: 0 }
  }

  const matchingSegments = settingsSearchSegments(section).filter((segment) =>
    segment.searchText.includes(query)
  )
  if (matchingSegments.length === 0) return null

  return {
    matches: matchingSegments.slice(0, MAX_SETTINGS_MATCHES).map((segment) => ({
      text: excerpt(segment.text, query),
      controlId: segment.controlId,
      targetId: segment.targetId,
      startIndex: segment.startIndex,
      endIndex: segment.endIndex
    })),
    totalMatches: matchingSegments.length
  }
}
