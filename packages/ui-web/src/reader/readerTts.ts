import { ReaderSpeechSession, ReaderSpeechState } from "./ReaderSpeechSession"
import {
  createReaderSpeechSegments,
  createReaderSpeechSegmentsWith,
  normalizeReaderSpeechText,
  splitReaderSpeechText
} from "./readerSpeechText"

export type ReaderTtsControl =
  | { type: "play-toggle" }
  | { type: "stop" }
  | { type: "prev" }
  | { type: "next" }
  | { type: "set-rate"; rate: number }
  | { type: "set-voice"; voice: string }

export type ReaderTtsState = ReaderSpeechState

export interface ReaderTtsOptions {
  initialRate?: number
  onRateChange?: (rate: number) => void
  claimOwnership?: () => void
  releaseOwnership?: () => void
  subscribeToStop?: (handler: () => void) => (() => void) | undefined
  subscribeToControl?: (
    handler: (control: ReaderTtsControl) => void
  ) => (() => void) | undefined
  onStateChange?: (state: ReaderTtsState) => void
}

interface ReaderTtsRuntime {
  applyControl: typeof applyExternalControl
  bindDom: typeof bindReaderTtsDom
  createChannel: typeof createOwnershipChannel
  initialRate: typeof readInitialRate
  persistRate: typeof storeRate
  populateVoiceOptions: typeof populateVoices
  showTtsUnavailable: typeof showUnavailable
}

const readerTtsRuntime: ReaderTtsRuntime = {
  applyControl: applyExternalControl,
  bindDom: bindReaderTtsDom,
  createChannel: createOwnershipChannel,
  initialRate: readInitialRate,
  persistRate: storeRate,
  populateVoiceOptions: populateVoices,
  showTtsUnavailable: showUnavailable
}

export function installReaderTts(options: ReaderTtsOptions = {}): void {
  runReaderTts(
    options,
    ReaderSpeechSession,
    createReaderSpeechSegments,
    readerTtsRuntime
  )
}

function runReaderTts(
  options: ReaderTtsOptions,
  Session: typeof ReaderSpeechSession,
  createSegments: typeof createReaderSpeechSegments,
  runtime: ReaderTtsRuntime
): void {
  const {
    applyControl,
    bindDom,
    createChannel,
    initialRate: resolveInitialRate,
    populateVoiceOptions,
    showTtsUnavailable
  } = runtime
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
    showTtsUnavailable(
      [play, stop, back, forward, voiceSelect, rateInput],
      play,
      voiceSettings
    )
    return
  }

  const segments = createSegments(article)
  const storageKey = "once:reader:tts-rate"
  const initialRate = resolveInitialRate(options.initialRate, storageKey)
  if (initialRate >= 0.5 && initialRate <= 6) rateInput.value = String(initialRate)

  const ownerId = `${Date.now()}-${Math.random()}`
  const ownershipChannel = createChannel(options)
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
  }
  const session = new Session({
    engine: synth,
    createUtterance: (text) => new SpeechSynthesisUtterance(text),
    texts: segments.map((segment) => segment.text),
    initialRate,
    claimOwnership: () => {
      options.claimOwnership?.()
    },
    releaseOwnership: options.releaseOwnership,
    ownershipChannel,
    ownerId,
    onPositionChange: highlight,
    onError: (error) => console.error("Reader speech failed", error),
    onStateChange: (state) => updateControls(state)
  })

  const updateControls = (state: ReaderTtsState): void => {
    const action = state.playing
      ? (state.paused ? "Resume" : "Pause")
      : (state.segment > 0 ? "Resume" : "Play")
    play.dataset.playing = String(state.playing && !state.paused)
    play.title = action
    play.setAttribute("aria-label", action + " article")
    stop.disabled = !state.playing
    back.disabled = !state.playing || state.segment <= 0
    forward.disabled = !state.playing || state.segment >= segments.length - 1
    rateInput.value = String(state.rate)
    rateValue.textContent = `${state.rate.toFixed(1)}×`
    options.onStateChange?.(state)
    if (!state.playing && state.segment === 0) clearHighlight()
  }

  bindDom({
    play, stop, back, forward, voiceSelect, voiceSettings, rateInput, rateValue,
    segments, session, options, storageKey
  }, runtime.persistRate)
  populateVoiceOptions(voiceSelect, synth.getVoices())
  synth.addEventListener?.("voiceschanged", () => {
    populateVoiceOptions(voiceSelect, synth.getVoices())
    session.notify()
  })
  const unsubscribeStop = options.subscribeToStop?.(() => session.yield())
  const unsubscribeControl = options.subscribeToControl?.((control) => {
    applyControl(
      control,
      session,
      voiceSelect,
      options,
      storageKey,
      runtime.persistRate
    )
  })
  window.addEventListener("pagehide", () => {
    session.dispose()
    unsubscribeStop?.()
    unsubscribeControl?.()
  }, { once: true })
  session.notify()

}

export function createStandaloneReaderTtsScript(): string {
  return `(() => {
    const normalizeReaderSpeechText = ${normalizeReaderSpeechText.toString()};
    const splitReaderSpeechText = ${splitReaderSpeechText.toString()};
    const createReaderSpeechSegmentsWith = ${createReaderSpeechSegmentsWith.toString()};
    const createReaderSpeechSegments = (root, maximum = 900) =>
      createReaderSpeechSegmentsWith(
        root,
        maximum,
        normalizeReaderSpeechText,
        splitReaderSpeechText
      );
    const ReaderSpeechSession = ${ReaderSpeechSession.toString()};
    const readInitialRate = ${readInitialRate.toString()};
    const storeRate = ${storeRate.toString()};
    const showUnavailable = ${showUnavailable.toString()};
    const populateVoices = ${populateVoices.toString()};
    const bindReaderTtsDom = ${bindReaderTtsDom.toString()};
    const applyExternalControl = ${applyExternalControl.toString()};
    const createOwnershipChannel = ${createOwnershipChannel.toString()};
    const runReaderTts = ${runReaderTts.toString()};
    const runtime = {
      applyControl: applyExternalControl,
      bindDom: bindReaderTtsDom,
      createChannel: createOwnershipChannel,
      initialRate: readInitialRate,
      persistRate: storeRate,
      populateVoiceOptions: populateVoices,
      showTtsUnavailable: showUnavailable
    };
    runReaderTts({}, ReaderSpeechSession, createReaderSpeechSegments, runtime);
  })();`
}

function createOwnershipChannel(options: ReaderTtsOptions): BroadcastChannel | undefined {
  if (options.claimOwnership || typeof BroadcastChannel === "undefined") return undefined
  try {
    return new BroadcastChannel("once-reader-tts")
  } catch {
    return undefined
  }
}

interface ReaderTtsDomBinding {
  play: HTMLButtonElement
  stop: HTMLButtonElement
  back: HTMLButtonElement
  forward: HTMLButtonElement
  voiceSelect: HTMLSelectElement
  voiceSettings: HTMLDetailsElement | null
  rateInput: HTMLInputElement
  rateValue: HTMLElement
  segments: ReturnType<typeof createReaderSpeechSegments>
  session: ReaderSpeechSession
  options: ReaderTtsOptions
  storageKey: string
}

function bindReaderTtsDom(
  binding: ReaderTtsDomBinding,
  persistRate: typeof storeRate
): void {
  const {
    play, stop, back, forward, voiceSelect, voiceSettings, rateInput, rateValue,
    segments, session, options, storageKey
  } = binding
  play.addEventListener("click", () => session.toggle())
  stop.addEventListener("click", () => session.stop())
  back.addEventListener("click", () => session.previous())
  forward.addEventListener("click", () => session.next())
  voiceSelect.addEventListener("change", () => {
    if (voiceSettings) voiceSettings.open = false
    session.setVoice(voiceSelect.value)
  })
  rateInput.addEventListener("input", () => {
    rateValue.textContent = `${Number(rateInput.value).toFixed(1)}×`
    session.previewRate(Number(rateInput.value))
  })
  rateInput.addEventListener("change", () => {
    const rate = Number(rateInput.value)
    persistRate(options, storageKey, rate)
    session.setRate(rate)
  })
  document.addEventListener("pointerdown", (event) => {
    if (voiceSettings?.open && event.target instanceof Node && !voiceSettings.contains(event.target)) {
      voiceSettings.open = false
    }
  })
  Array.from(new Set(segments.map((segment) => segment.element))).forEach((element) => {
    element.classList.add("tts-segment")
    element.title = "Start reading here"
    element.addEventListener("click", () => {
      const index = segments.findIndex((segment) => segment.element === element)
      if (index >= 0) session.start(index)
    })
  })
}

function applyExternalControl(
  control: ReaderTtsControl,
  session: ReaderSpeechSession,
  voiceSelect: HTMLSelectElement,
  options: ReaderTtsOptions,
  storageKey: string,
  persistRate: typeof storeRate
): void {
  switch (control.type) {
    case "play-toggle": session.toggle(); break
    case "stop": session.stop(); break
    case "prev": session.previous(); break
    case "next": session.next(); break
    case "set-rate":
      persistRate(options, storageKey, Math.min(6, Math.max(0.5, control.rate)))
      session.setRate(control.rate)
      break
    case "set-voice":
      voiceSelect.value = control.voice
      session.setVoice(control.voice)
      break
  }
}

function readInitialRate(provided: number | undefined, storageKey: string): number {
  if (provided != null) return Number.isFinite(provided) ? provided : 1
  try {
    const stored = Number(localStorage.getItem(storageKey))
    return Number.isFinite(stored) && stored > 0 ? stored : 1
  } catch {
    return 1
  }
}

function storeRate(options: ReaderTtsOptions, storageKey: string, rate: number): void {
  if (options.onRateChange) options.onRateChange(rate)
  else {
    try {
      localStorage.setItem(storageKey, String(rate))
    } catch {
      // Reader playback remains usable when storage is disabled.
    }
  }
}

function showUnavailable(
  controls: Array<HTMLButtonElement | HTMLSelectElement | HTMLInputElement>,
  play: HTMLButtonElement,
  settings: HTMLDetailsElement | null
): void {
  controls.forEach((control) => { control.disabled = true })
  settings?.setAttribute("hidden", "")
  const message = "Text to speech is not available on this device."
  play.title = message
  const notice = document.createElement("p")
  notice.className = "tts-unavailable"
  notice.dataset.testid = "tts-unavailable"
  notice.setAttribute("role", "status")
  notice.textContent = message
  document.querySelector(".tts-controls")?.append(notice)
}

function populateVoices(select: HTMLSelectElement, voices: SpeechSynthesisVoice[]): void {
  const previous = select.value
  const available = [...voices].sort((a, b) =>
    `${a.lang} ${a.name}`.localeCompare(`${b.lang} ${b.name}`)
  )
  select.innerHTML = ""
  const automatic = document.createElement("option")
  automatic.value = ""
  automatic.textContent = "Default voice"
  select.append(automatic)
  available.forEach((voice) => {
    const option = document.createElement("option")
    option.value = voice.voiceURI
    option.textContent = `${voice.name} (${voice.lang})`
    select.append(option)
  })
  if (available.some((voice) => voice.voiceURI === previous)) select.value = previous
}
