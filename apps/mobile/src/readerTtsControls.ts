import { ReaderTtsHostController } from "./readerTtsHostBridge"

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
