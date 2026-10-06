// The warning and error glyphs on the Settings tab are a per-device choice:
// the Appearance switch shows it, and the body class hides the glyphs while
// the error log row keeps its counts.
const ISSUE_ICONS_KEY = "once:mobile-settings-issue-icons"

function storedIssueIconsShown(): boolean {
  try {
    return localStorage.getItem(ISSUE_ICONS_KEY) !== "hidden"
  } catch { return true }
}

function apply(shown: boolean): void {
  document.body.classList.toggle("once-hide-settings-issue-icons", !shown)
}

/** Binds the switch in the mobile Layout group, which the story card reveals. */
export function bindSettingsIssueIcons(): void {
  const box = document.querySelector<HTMLInputElement>("#mobile_settings_issue_icons")
  if (!box) return
  box.checked = storedIssueIconsShown()
  apply(box.checked)
  box.addEventListener("change", () => {
    try {
      localStorage.setItem(ISSUE_ICONS_KEY, box.checked ? "shown" : "hidden")
    } catch { /* private mode or quota: the choice lasts the session */ }
    apply(box.checked)
  })
}
