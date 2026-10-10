import { copyErrorText } from "./copyErrorText"
import {
  clearConsoleEntries,
  consoleEntries,
  currentConsoleSession,
  formatConsoleEntry,
  installConsoleCapture,
  onConsoleEntries
} from "./consoleCapture"

const COPY_FEEDBACK_DELAY = 1500

let bound = false

/** The error log's console messages: hidden until asked for, cleared with the log while shown. */
export function bindConsoleLog(): void {
  installConsoleCapture()
  if (bound) return
  const toggle = document.querySelector<HTMLButtonElement>("#toggle_console_log")
  const section = document.querySelector<HTMLElement>("#console_log")
  const text = document.querySelector<HTMLElement>("#console_log_text")
  if (!toggle || !section || !text) return
  bound = true

  const render = () => {
    if (section.hidden) return
    const session = currentConsoleSession()
    const lines: string[] = []
    let previous: string | undefined
    for (const entry of consoleEntries()) {
      // Launches are marked only once an earlier one is in the log.
      if (entry.session !== previous && (previous !== undefined || entry.session !== session)) {
        lines.push(entry.session === session ? "— this launch —" : "— earlier launch —")
      }
      previous = entry.session
      lines.push(formatConsoleEntry(entry))
    }
    text.textContent = lines.length ? lines.join("\n") : "No console messages recorded."
  }
  onConsoleEntries(render)

  toggle.addEventListener("click", () => {
    section.hidden = !section.hidden
    toggle.setAttribute("aria-expanded", String(!section.hidden))
    toggle.textContent = section.hidden ? "Show console messages" : "Hide console messages"
    render()
  })
  document.querySelector("#clear_error_log")?.addEventListener("click", () => {
    if (!section.hidden) clearConsoleEntries()
  })
  const copy = document.querySelector<HTMLButtonElement>("#copy_console_log")
  copy?.addEventListener("click", () => {
    void copyErrorText(consoleEntries().map(formatConsoleEntry).join("\n")).then((copied) => {
      copy.textContent = copied ? "Copied" : "Copy failed"
      window.setTimeout(() => { copy.textContent = "Copy console messages" }, COPY_FEEDBACK_DELAY)
    })
  })
}
