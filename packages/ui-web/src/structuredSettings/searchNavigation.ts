export type StructuredSettingsSection = "sources" | "filters" | "redirects"

function highlightMatches(
  element: HTMLElement,
  value: string,
  query: string
): void {
  element.textContent = ""
  if (!query) {
    element.textContent = value
    return
  }
  const normalizedValue = value.toLowerCase()
  let start = 0
  let match = normalizedValue.indexOf(query)
  while (match !== -1) {
    element.append(document.createTextNode(value.slice(start, match)))
    const mark = document.createElement("mark")
    mark.textContent = value.slice(match, match + query.length)
    element.append(mark)
    start = match + query.length
    match = normalizedValue.indexOf(query, start)
  }
  element.append(document.createTextNode(value.slice(start)))
}

export function renderStructuredSearch(
  root: HTMLElement,
  section: StructuredSettingsSection,
  queries: Map<StructuredSettingsSection, string>
): void {
  const labels: Record<StructuredSettingsSection, string> = {
    sources: "story sources",
    filters: "filters",
    redirects: "redirects"
  }
  const search = document.createElement("label")
  search.className = "structured_search"
  const text = document.createElement("span")
  text.className = "visually_hidden"
  text.textContent = `Search ${labels[section]}`
  const input = document.createElement("input")
  input.type = "search"
  input.placeholder = `Search ${labels[section]}`
  input.value = queries.get(section) || ""
  input.dataset.testid = `${section}-list-search`
  input.setAttribute("aria-label", text.textContent)
  const status = document.createElement("span")
  status.className = "structured_search_status"
  status.setAttribute("role", "status")
  status.setAttribute("aria-live", "polite")
  input.addEventListener("input", () => {
    queries.set(section, input.value)
    applyStructuredSearch(root, section, queries)
  })
  search.append(text, input, status)
  root.append(search)
}

export function applyStructuredSearch(
  root: HTMLElement,
  section: StructuredSettingsSection,
  queries: Map<StructuredSettingsSection, string>
): void {
  const query = (queries.get(section) || "").trim().toLowerCase()
  let visible = 0
  if (section === "sources") {
    root.querySelectorAll<HTMLDetailsElement>(".structured_group").forEach(
      (group) => {
        const groupMatches = (group.dataset.searchValue || "").includes(query)
        const groupName = group.querySelector<HTMLElement>(
          ".structured_group_name"
        )
        if (groupName) {
          highlightMatches(
            groupName,
            groupName.dataset.searchText || "",
            query
          )
        }
        let groupVisible = false
        group.querySelectorAll<HTMLElement>(".structured_row").forEach((row) => {
          const matches = !query || groupMatches ||
            (row.dataset.searchValue || "").includes(query)
          row.hidden = !matches
          row.querySelectorAll<HTMLElement>("[data-search-text]").forEach(
            (element) => highlightMatches(
              element,
              element.dataset.searchText || "",
              query
            )
          )
          if (matches) {
            visible++
            groupVisible = true
          }
        })
        const empty = group.querySelector<HTMLElement>(".structured_empty")
        if (empty) empty.hidden = Boolean(query) && !groupMatches
        group.hidden = Boolean(query) && !groupMatches && !groupVisible
        if (query && !group.hidden) group.open = true
      }
    )
  } else {
    root.querySelectorAll<HTMLElement>(".structured_row").forEach((row) => {
      if (row.classList.contains("structured_row_editing")) return
      const matches = !query ||
        (row.dataset.searchValue || "").includes(query)
      row.hidden = !matches
      if (matches) visible++
    })
  }
  const status = root.querySelector<HTMLElement>(".structured_search_status")
  if (status) {
    status.textContent = query
      ? `${visible} ${visible === 1 ? "result" : "results"}`
      : ""
  }
}
