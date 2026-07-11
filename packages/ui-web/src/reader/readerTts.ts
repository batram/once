export function installReaderTts(options: {
  initialRate?: number
  onRateChange?: (rate: number) => void
  claimOwnership?: () => void
  releaseOwnership?: () => void
  subscribeToStop?: (handler: () => void) => (() => void) | void
} = {}): void {
  if (document.documentElement.dataset.onceTtsInstalled === "true") return
  document.documentElement.dataset.onceTtsInstalled = "true"

  const synth = window.speechSynthesis
  const play = document.querySelector<HTMLButtonElement>("[data-tts-play]")
  const stop = document.querySelector<HTMLButtonElement>("[data-tts-stop]")
  const back = document.querySelector<HTMLButtonElement>("[data-tts-back]")
  const forward = document.querySelector<HTMLButtonElement>("[data-tts-forward]")
  const voiceSelect = document.querySelector<HTMLSelectElement>("[data-tts-voice]")
  const voiceSettings = document.querySelector<HTMLDetailsElement>(".tts-settings")
  const rateInput = document.querySelector<HTMLInputElement>("[data-tts-rate]")
  const rateValue = document.querySelector<HTMLElement>("[data-tts-rate-value]")
  const article = document.querySelector<HTMLElement>("article")
  if (!play || !stop || !back || !forward || !voiceSelect || !rateInput || !rateValue || !article) return

  if (!synth || typeof SpeechSynthesisUtterance === "undefined") {
    ;[play, stop, back, forward, voiceSelect, rateInput].forEach((control) => {
      control.disabled = true
    })
    play.title = "Text to speech is not available in this browser"
    return
  }

  const storageKey = "once:reader:tts-rate"
  let initialRate = options.initialRate
  if (initialRate == null) {
    try {
      initialRate = Number(localStorage.getItem(storageKey))
    } catch {
      initialRate = 1
    }
  }
  if (Number.isFinite(initialRate) && initialRate >= 0.5 && initialRate <= 6) {
    rateInput.value = String(initialRate)
  }

  const storeRate = (rate: number): void => {
    if (options.onRateChange) {
      options.onRateChange(rate)
      return
    }
    try {
      localStorage.setItem(storageKey, String(rate))
    } catch {
      // Reader playback remains usable when storage is disabled.
    }
  }

  const segments = createSegments(article)
  let currentIndex = 0
  let active = false
  let paused = false
  let generation = 0
  const ownerId = `${Date.now()}-${Math.random()}`
  let ownershipChannel: BroadcastChannel | null = null
  const playIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor" stroke="none"/></svg>'
  const pauseIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5h3v14H8zM14 5h3v14h-3z" fill="currentColor" stroke="none"/></svg>'

  const voices = (): SpeechSynthesisVoice[] => synth.getVoices()
  const selectedVoice = (): SpeechSynthesisVoice | undefined =>
    voices().find((voice) => voice.voiceURI === voiceSelect.value)

  const populateVoices = (): void => {
    const previous = voiceSelect.value
    const available = voices().sort((a, b) =>
      `${a.lang} ${a.name}`.localeCompare(`${b.lang} ${b.name}`)
    )
    voiceSelect.innerHTML = ""
    const automatic = document.createElement("option")
    automatic.value = ""
    automatic.textContent = "Default voice"
    voiceSelect.append(automatic)
    available.forEach((voice) => {
      const option = document.createElement("option")
      option.value = voice.voiceURI
      option.textContent = `${voice.name} (${voice.lang})`
      voiceSelect.append(option)
    })
    if (available.some((voice) => voice.voiceURI === previous)) {
      voiceSelect.value = previous
    }
  }

  const updateControls = (): void => {
    const action = active
      ? (paused ? "Resume" : "Pause")
      : (currentIndex > 0 ? "Resume" : "Play")
    play.innerHTML = active && !paused ? pauseIcon : playIcon
    play.title = action
    play.setAttribute("aria-label", action + " article")
    stop.disabled = !active
    back.disabled = !active || currentIndex <= 0
    forward.disabled = !active || currentIndex >= segments.length - 1
    rateValue.textContent = `${Number(rateInput.value).toFixed(1)}×`
  }

  const clearHighlight = (): void => {
    article.querySelector(".tts-current")?.classList.remove("tts-current")
  }

  const highlight = (index: number): void => {
    clearHighlight()
    const segment = segments[index]
    if (!segment) return
    segment.element.classList.add("tts-current")
    const bounds = segment.element.getBoundingClientRect()
    if (bounds.top < 64 || bounds.bottom > window.innerHeight - 24) {
      segment.element.scrollIntoView({ behavior: "smooth", block: "center" })
    }
    updateControls()
  }

  const finish = (resetPosition = true): void => {
    active = false
    paused = false
    if (resetPosition) {
      currentIndex = 0
      clearHighlight()
    } else {
      highlight(currentIndex)
    }
    updateControls()
    options.releaseOwnership?.()
  }

  const stopPlayback = (): void => {
    generation += 1
    synth.cancel()
    finish()
  }

  const yieldPlayback = (): void => {
    generation += 1
    synth.cancel()
    finish(false)
  }

  const start = (from = currentIndex): void => {
    options.claimOwnership?.()
    ownershipChannel?.postMessage({ type: "claim", ownerId })
    synth.cancel()
    generation += 1
    const run = generation
    currentIndex = Math.max(0, Math.min(from, Math.max(0, segments.length - 1)))
    active = segments.length > 0
    paused = false
    updateControls()
    if (!active) return

    // Queue paragraph-sized chunks together. Native speech synthesis can then
    // transition without the start/stop gap caused by sentence-by-sentence calls.
    for (let index = currentIndex; index < segments.length; index += 1) {
      const utterance = new SpeechSynthesisUtterance(segments[index].text)
      utterance.rate = Number(rateInput.value)
      const voice = selectedVoice()
      if (voice) utterance.voice = voice
      utterance.onstart = () => {
        if (run !== generation) return
        currentIndex = index
        highlight(index)
      }
      utterance.onend = () => {
        if (run === generation && index === segments.length - 1) finish()
      }
      utterance.onerror = (event) => {
        if (run !== generation || event.error === "canceled" || event.error === "interrupted") return
        finish()
        console.error("Reader speech failed", event.error)
      }
      synth.speak(utterance)
    }
  }

  play.addEventListener("click", () => {
    if (!active) {
      start(currentIndex)
    } else if (paused) {
      synth.resume()
      paused = false
      updateControls()
    } else {
      synth.pause()
      paused = true
      updateControls()
    }
  })
  stop.addEventListener("click", () => {
    stopPlayback()
  })
  back.addEventListener("click", () => {
    if (active) start(Math.max(0, currentIndex - 1))
  })
  forward.addEventListener("click", () => {
    if (active) start(Math.min(segments.length - 1, currentIndex + 1))
  })
  voiceSelect.addEventListener("change", () => {
    if (voiceSettings) voiceSettings.open = false
    if (active) start(currentIndex)
  })
  document.addEventListener("pointerdown", (event) => {
    if (
      voiceSettings?.open &&
      event.target instanceof Node &&
      !voiceSettings.contains(event.target)
    ) {
      voiceSettings.open = false
    }
  })
  rateInput.addEventListener("input", updateControls)
  rateInput.addEventListener("change", () => {
    storeRate(Number(rateInput.value))
    if (active) start(currentIndex)
  })
  Array.from(new Set(segments.map((segment) => segment.element))).forEach((element) => {
    element.classList.add("tts-segment")
    element.title = "Start reading here"
    element.addEventListener("click", () => {
      const index = segments.findIndex((segment) => segment.element === element)
      if (index >= 0) start(index)
    })
  })

  populateVoices()
  synth.addEventListener?.("voiceschanged", populateVoices)
  const unsubscribeStop = options.subscribeToStop?.(yieldPlayback)
  if (!options.claimOwnership && typeof BroadcastChannel !== "undefined") {
    try {
      ownershipChannel = new BroadcastChannel("once-reader-tts")
      ownershipChannel.addEventListener("message", (event) => {
        if (event.data?.type === "claim" && event.data.ownerId !== ownerId) {
          yieldPlayback()
        }
      })
    } catch {
      ownershipChannel = null
    }
  }
  window.addEventListener("pagehide", () => {
    stopPlayback()
    if (typeof unsubscribeStop === "function") unsubscribeStop()
    ownershipChannel?.close()
  }, { once: true })
  updateControls()

  function createSegments(root: HTMLElement): Array<{ element: HTMLElement; text: string }> {
    const blockSelector = "p,li,h2,h3,h4,h5,h6,blockquote,pre,figcaption,td,th"
    let blocks = Array.from(root.querySelectorAll<HTMLElement>(blockSelector))
      .filter((element) => !element.querySelector(blockSelector))
    if (blocks.length === 0) blocks = [root]

    const result: Array<{ element: HTMLElement; text: string }> = []
    blocks.forEach((element) => {
      // innerText follows the rendered reading order and contributes spacing
      // around block/line-break elements without exposing HTML markup to TTS.
      const text = normalizeSpeechText(element.innerText || element.textContent || "")
      if (!text) return
      splitLongText(text, 900).forEach((chunk) => {
        result.push({ element, text: chunk })
      })
    })
    return result
  }

  function normalizeSpeechText(value: string): string {
    return value
      .normalize("NFKC")
      .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
      .replace(/https?:\/\/\S+/gi, (url) => {
        try {
          return new URL(url.replace(/[),.;!?]+$/, "")).hostname.replace(/^www\./, "")
        } catch {
          return "link"
        }
      })
      .replace(/[•·▪◦]+/g, ". ")
      .replace(/[—–]+/g, ", ")
      .replace(/…+/g, ". ")
      .replace(/&/g, " and ")
      .replace(/[@#*_~=<>|^]+/g, " ")
      .replace(/([!?.,])\1+/g, "$1")
      .replace(/\s+/g, " ")
      .trim()
  }

  function splitLongText(value: string, maximum: number): string[] {
    if (value.length <= maximum) return [value]
    const sentences = value.match(/[^.!?]+(?:[.!?]+["')\]]*|$)\s*/g) || [value]
    const chunks: string[] = []
    let current = ""
    sentences.forEach((sentence) => {
      const clean = sentence.trim()
      if (!clean) return
      if (current && current.length + clean.length + 1 > maximum) {
        chunks.push(current)
        current = ""
      }
      if (clean.length > maximum) {
        const words = clean.split(" ")
        words.forEach((word) => {
          if (current && current.length + word.length + 1 > maximum) {
            chunks.push(current)
            current = ""
          }
          current += `${current ? " " : ""}${word}`
        })
      } else {
        current += `${current ? " " : ""}${clean}`
      }
    })
    if (current) chunks.push(current)
    return chunks
  }
}
