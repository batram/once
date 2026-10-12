import { ReaderTtsHostController } from "./readerTtsHostBridge"
import type { ReaderAiPagesState } from "./readerTtsProtocol"

export interface ReaderTtsUiControls {
  /** Shows the bar for the selected tab's reader; hiding it leaves speech running. */
  setReaderMode(active: boolean): void
  /** The selected tab changed: show its reader's state, keep the old one speaking. */
  tabChanged(): void
  /** Stops the selected tab's reader speech. */
  stop(): void
  dismiss(): void
}

export function installReaderTtsControls(
  controller: ReaderTtsHostController
): ReaderTtsUiControls {
  const pill = required("#reader_tts_pill")
  const play = required<HTMLButtonElement>('[data-host-tts="play"]')
  const voice = required<HTMLSelectElement>("#reader_tts_voice")
  const rates = required("#reader_tts_rates")

  play.onclick = (): void => {
    controller.send({ type: "ui-play-toggle" })
  }
  required<HTMLButtonElement>('[data-host-tts="prev"]').onclick = () =>
    controller.send({ type: "ui-prev" })
  required<HTMLButtonElement>('[data-host-tts="next"]').onclick = () =>
    controller.send({ type: "ui-next" })
  required<HTMLButtonElement>('[data-host-tts="stop"]').onclick = () =>
    controller.send({ type: "ui-stop" })
  voice.onchange = () =>
    controller.send({ type: "ui-set-voice", voice: voice.value })

  const ai = required<HTMLButtonElement>('[data-host-ai="rewrite"]')
  const undo = required<HTMLButtonElement>('[data-host-ai="undo"]')
  const strip = required("#reader_ai_strip")
  const aiStatus = required("#reader_ai_status")
  const pagesLabel = required("#reader_ai_pages")
  const next = required<HTMLButtonElement>('[data-host-ai="continue"]')
  const end = required<HTMLButtonElement>('[data-host-ai="finish"]')
  for (const button of [ai, undo, next, end]) {
    button.onclick = () => controller.send({ type: "ui-ai", action: button.dataset.hostAi as "rewrite" | "undo" | "continue" | "finish" })
  }
  const showAi = (state: { running: boolean; canUndo: boolean; status: string; madeBy: string; pages?: ReaderAiPagesState } = { running: false, canUndo: false, status: "", madeBy: "" }): void => {
    ai.textContent = state.running ? "Cancel" : "AI"
    ai.setAttribute("aria-label", state.running ? "Cancel AI rewrite" : "Rewrite with AI")
    ai.title = state.madeBy ? `Rewritten by ${state.madeBy}` : ""
    undo.hidden = !state.canUndo
    undo.disabled = state.running
    // Progress while running; afterwards only an error remains.
    aiStatus.textContent = state.status
    aiStatus.dataset.error = String(!state.running && !!state.status)
    // A long scan read in parts: how far, and the next pages without scrolling to the end.
    const pages = state.pages, open = !!pages && pages.through < pages.total
    pagesLabel.textContent = pages ? `${pages.through}/${pages.total}${pages.ai ? " AI" : ""}` : ""
    pagesLabel.setAttribute("aria-label", pages ? `Pages 1 to ${pages.through} of ${pages.total}${pages.ai ? ", rewritten with AI" : ""}` : "")
    next.hidden = end.hidden = !open
    next.textContent = pages ? `Next ${Math.min(5, pages.total - pages.through)}` : "Next"
    next.disabled = state.running
    end.textContent = pages?.toEnd ? "Stop" : "To end"
    end.disabled = state.running && !pages?.toEnd
    strip.hidden = !state.status && !open
  }

  for (const rate of [1, 1.25, 1.5, 2, 3]) {
    const button = document.createElement("button")
    button.type = "button"
    button.className = "button"
    button.textContent = `${rate}×`
    button.onclick = () => {
      controller.send({ type: "ui-set-rate", rate })
      required<HTMLDetailsElement>("#reader_tts_settings").open = false
    }
    rates.append(button)
  }

  controller.subscribe((state) => {
    play.textContent = state.playing && !state.paused ? "Ⅱ" : "▶"
    play.setAttribute(
      "aria-label",
      state.playing && !state.paused ? "Pause article" : "Play article"
    )
    required("#reader_tts_rate_label").textContent = `${state.rate}×`
    const selected = voice.value
    voice.replaceChildren(new Option("Default voice", ""))
    for (const item of state.voices) {
      voice.append(new Option(`${item.name} (${item.lang})`, item.voiceURI))
    }
    voice.value = state.voice || selected
    showAi(state.ai)
  })

  const hide = (): void => {
    pill.hidden = true
    required<HTMLDetailsElement>("#reader_tts_settings").open = false
  }
  return {
    setReaderMode(active) {
      if (!active) { hide(); return }
      // Shown for a (possibly different) tab: reflect that tab's reader.
      if (pill.hidden) controller.refresh()
      pill.hidden = false
    },
    tabChanged() {
      hide()
      // Nothing may linger from the previous tab when the new one never spoke.
      play.textContent = "▶"
      play.setAttribute("aria-label", "Play article")
      showAi()
    },
    stop() {
      controller.send({ type: "ui-stop" })
    },
    dismiss() {
      controller.send({ type: "ui-stop" })
      hide()
    }
  }
}

function required<T extends HTMLElement = HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector)
  if (!element) throw new Error(`Missing mobile TTS control: ${selector}`)
  return element
}
