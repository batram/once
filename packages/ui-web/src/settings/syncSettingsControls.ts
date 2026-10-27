import { requireClosestElement, requireElement } from "../dom"

/**
 * The sync URL field. Hidden, the input holds the URL without its username and
 * password: there is no credential in the DOM to select, copy or glimpse, and
 * nothing to keep in step with the text. The credentials wait in here and go
 * back into the URL when it is read. Shown, the input holds the whole URL.
 */
export interface SyncUrlField {
  /** The whole URL, credentials included. */
  get(): string
  /** Loads a whole URL into the field, keeping its credentials hidden or shown as the field is. */
  set(url: string): void
}

/** scheme:// | user:pass@ | the rest. Text, not URL parsing, so a half-typed URL still splits. */
const AUTHORITY = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#@]*@)?([\s\S]*)$/i

function split(url: string): { scheme: string; credentials: string; rest: string } | null {
  const match = AUTHORITY.exec(url)
  if (!match) return null
  return { scheme: match[1], credentials: match[2] ?? "", rest: match[3] }
}

/** The URL with `credentials` ("user:pass@") in place of any it carries. */
export function withCredentials(url: string, credentials: string): string {
  const parts = split(url)
  if (!parts) return url
  return parts.scheme + credentials + parts.rest
}

export function bindSyncSettingsControls(
  load: () => Promise<string>,
  save: (url: string) => void
): SyncUrlField {
  const input = requireElement<HTMLInputElement>("#couch_input")
  const container = requireClosestElement<HTMLElement>(input, ".couch-container")
  const toggle = requireElement<HTMLButtonElement>("#couch_toggle", container)
  const icon = requireElement<HTMLElement>(".icon", toggle)
  // Scoped to the block rather than walked up from the input: the field around
  // the input is presentation, and presentation must not decide what this can
  // still find.
  const block = requireClosestElement<HTMLElement>(input, ".settings_block")
  const hint = requireElement<HTMLElement>("#couch_hint", block)

  let shown = false
  // Held back from the input while hidden; "" when the URL has none.
  let credentials = ""

  const render = () => {
    toggle.setAttribute("aria-pressed", String(shown))
    toggle.setAttribute("aria-label", shown
      ? "Hide username and password"
      : "Show username and password")
    icon.classList.toggle("icon--eye", !shown)
    icon.classList.toggle("icon--eye-off", shown)
    hint.hidden = shown || !credentials
  }

  const field: SyncUrlField = {
    get: () => {
      if (shown) return input.value
      // Credentials typed into the hidden field are the reader's own choice
      // and replace the held ones; otherwise the held ones go back in.
      const typed = split(input.value)
      if (!typed || typed.credentials) return input.value
      return withCredentials(input.value, credentials)
    },
    set: (url) => {
      if (shown) {
        credentials = ""
        input.value = url
      } else {
        credentials = split(url)?.credentials ?? ""
        input.value = withCredentials(url, "")
      }
      render()
    }
  }

  toggle.addEventListener("click", (event) => {
    event.preventDefault()
    const url = field.get()
    shown = !shown
    field.set(url)
  })
  input.addEventListener("input", render)
  requireElement<HTMLButtonElement>('button[data-action="save"]', block)
    .addEventListener("click", () => {
      const url = field.get()
      save(url)
      // Credentials pasted into the hidden field go back out of sight.
      field.set(url)
    })
  requireElement<HTMLButtonElement>('button[data-action="cancel"]', block)
    .addEventListener("click", () => void load().then(field.set))
  void load().then(field.set)
  return field
}
