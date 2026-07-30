const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")
const ts = require("typescript")

const root = path.resolve(__dirname, "../../..")

function loadModule(relativePath, moduleShims = {}) {
  const source = fs.readFileSync(path.join(root, relativePath), "utf8")
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const moduleObject = { exports: {} }
  const shimmedRequire = (specifier) => {
    if (specifier in moduleShims) return moduleShims[specifier]
    throw new Error(`Unexpected import in ${relativePath}: ${specifier}`)
  }
  Function("exports", "module", "require", compiled)(
    moduleObject.exports, moduleObject, shimmedRequire
  )
  return moduleObject.exports
}

function createBridgePair() {
  // Fake postMessage plumbing between the sandboxed reader frame and the host
  // page: deliveries queue like real message events and flush asynchronously.
  const deliveries = []
  const frameListeners = []
  const hostListeners = []
  const frameHandle = {
    postMessage: (message) => deliveries.push(() =>
      frameListeners.forEach((listener) => listener({ data: message, source: parentHandle }))
    )
  }
  const parentHandle = {
    postMessage: (message) => deliveries.push(() =>
      hostListeners.forEach((listener) => listener({ data: message, source: frameHandle }))
    )
  }
  const frameWindow = {
    parent: parentHandle,
    addEventListener: (type, listener) => frameListeners.push(listener),
    document: { documentElement: { lang: "" } },
    navigator: { language: "en-US" }
  }
  const hostWindow = {
    addEventListener: (type, listener) => hostListeners.push(listener)
  }
  const settle = async () => {
    for (let round = 0; round < 20; round += 1) {
      while (deliveries.length > 0) deliveries.shift()()
      await new Promise((resolve) => setImmediate(resolve))
    }
  }
  return { frameWindow, hostWindow, frameHandle, settle }
}

function createFakeEngine() {
  const requests = []
  const engine = {
    stops: 0,
    speak: (options) => new Promise((resolve, reject) => {
      requests.push({ options, resolve, reject })
    }),
    stop: () => {
      engine.stops += 1
      return Promise.resolve()
    },
    getSupportedVoices: () => Promise.resolve({
      voices: [
        { voiceURI: "de-voice", name: "Vicki", lang: "de-DE", default: false, localService: true },
        { voiceURI: "en-voice", name: "Aria", lang: "en-US", default: true, localService: true }
      ]
    })
  }
  return { engine, requests }
}

async function setUp() {
  const protocol = loadModule("apps/mobile/src/readerTtsProtocol.ts")
  const adapter = loadModule("apps/mobile/src/ReaderTtsAdapter.ts", {
    "./readerTtsProtocol": protocol
  })
  const { installReaderTtsPolyfill } = loadModule("apps/mobile/src/readerTtsPolyfill.ts", {
    "./ReaderTtsAdapter": adapter
  })
  const { installReaderTtsHostBridge } = loadModule("apps/mobile/src/readerTtsHostBridge.ts", {
    "./readerTtsProtocol": protocol,
    "@capacitor-community/text-to-speech": {
      TextToSpeech: {},
      QueueStrategy: { Flush: 0, Add: 1 }
    }
  })
  const pair = createBridgePair()
  const { engine, requests } = createFakeEngine()
  installReaderTtsPolyfill(pair.frameWindow)
  installReaderTtsHostBridge(
    (source) => source === pair.frameHandle,
    engine,
    pair.hostWindow
  )
  await pair.settle()
  return { ...pair, engine, requests }
}

function trackedUtterance(frameWindow, text) {
  const utterance = new frameWindow.SpeechSynthesisUtterance(text)
  utterance.events = []
  utterance.onstart = () => utterance.events.push("start")
  utterance.onend = () => utterance.events.push("end")
  utterance.onerror = (event) => utterance.events.push(`error:${event.error}`)
  return utterance
}

test("polyfill installs bridged speech synthesis and reports host voices", async () => {
  const { frameWindow, settle } = await setUp()
  const synth = frameWindow.speechSynthesis
  assert.ok(synth, "speechSynthesis polyfill installed")
  assert.equal(typeof frameWindow.SpeechSynthesisUtterance, "function")
  await settle()
  assert.deepEqual(synth.getVoices().map((voice) => voice.voiceURI), ["de-voice", "en-voice"])
})

test("force replaces a present-but-broken Web Speech implementation", async () => {
  const protocol = loadModule("apps/mobile/src/readerTtsProtocol.ts")
  const adapter = loadModule("apps/mobile/src/ReaderTtsAdapter.ts", {
    "./readerTtsProtocol": protocol
  })
  const { installReaderTtsPolyfill } = loadModule("apps/mobile/src/readerTtsPolyfill.ts", {
    "./ReaderTtsAdapter": adapter
  })
  const posts = []
  const native = { native: true }
  const frameWindow = {
    parent: { postMessage: (message) => posts.push(message) },
    speechSynthesis: native,
    addEventListener: () => {}
  }

  installReaderTtsPolyfill(frameWindow)
  assert.equal(frameWindow.speechSynthesis, native, "without force an existing implementation wins")
  assert.equal(posts.length, 0)

  installReaderTtsPolyfill(frameWindow, { force: true })
  assert.notEqual(frameWindow.speechSynthesis, native, "force installs the bridge over Web Speech")
  assert.equal(typeof frameWindow.speechSynthesis.speak, "function")
  assert.equal(posts.length, 1)
  assert.equal(posts[0].channel, "once-reader-tts")
  assert.equal(posts[0].version, 1)
  assert.match(posts[0].sessionId, /^reader-/)
  assert.equal(posts[0].type, "voices")
})

test("versioned protocol rejects malformed and unscoped messages", () => {
  const protocol = loadModule("apps/mobile/src/readerTtsProtocol.ts")
  assert.equal(protocol.isReaderTtsRequest({
    channel: "once-reader-tts",
    version: 1,
    sessionId: "reader-test",
    type: "speak",
    id: 1,
    text: "Hello",
    rate: 1
  }), true)
  assert.equal(protocol.isReaderTtsRequest({
    channel: "once-reader-tts",
    version: 1,
    sessionId: "reader-test",
    type: "speak",
    text: "Missing id",
    rate: 1
  }), false)
  assert.equal(protocol.isReaderTtsRequest({
    channel: "once-reader-tts",
    version: 2,
    sessionId: "reader-test",
    type: "cancel"
  }), false)
})

test("queued utterances speak natively in order with start/end callbacks", async () => {
  const { frameWindow, settle, requests } = await setUp()
  const synth = frameWindow.speechSynthesis
  const first = trackedUtterance(frameWindow, "First paragraph.")
  const second = trackedUtterance(frameWindow, "Second paragraph.")
  first.rate = 1.5
  first.voice = synth.getVoices()[0]
  synth.speak(first)
  synth.speak(second)
  await settle()

  assert.equal(requests.length, 2, "both utterances queue immediately for gapless playback")
  assert.equal(requests[0].options.text, "First paragraph.")
  assert.equal(requests[0].options.rate, 1.5)
  assert.equal(requests[0].options.voice, 0)
  assert.equal(requests[0].options.lang, "de-DE")
  assert.equal(requests[0].options.queueStrategy, 1)
  assert.equal(requests[1].options.lang, "en-US", "falls back to the frame language")
  assert.deepEqual(first.events, ["start"], "first utterance starts as soon as it is queued")
  assert.deepEqual(second.events, [])

  requests[0].resolve()
  await settle()
  assert.deepEqual(first.events, ["start", "end"])
  assert.deepEqual(second.events, ["start"], "second starts when the first finishes")

  requests[1].resolve()
  await settle()
  assert.deepEqual(second.events, ["start", "end"])
  assert.equal(synth.speaking, false)
})

test("pause stops native playback and resume restarts from the interrupted utterance", async () => {
  const { frameWindow, settle, requests, engine } = await setUp()
  const synth = frameWindow.speechSynthesis
  const first = trackedUtterance(frameWindow, "First paragraph.")
  const second = trackedUtterance(frameWindow, "Second paragraph.")
  synth.speak(first)
  synth.speak(second)
  await settle()
  requests[0].resolve()
  await settle()
  assert.deepEqual(second.events, ["start"])

  synth.pause()
  await settle()
  assert.equal(engine.stops, 1, "pause maps to a native stop")
  // The stopped utterance settles after the cancel; its settlement must not
  // surface as a playback event or the reader would treat pause as finished.
  requests[1].reject(new Error("stopped"))
  await settle()
  assert.deepEqual(second.events, ["start"], "no end/error leaks from the pause stop")

  synth.resume()
  await settle()
  assert.equal(requests.length, 3, "resume re-speaks the interrupted utterance")
  assert.equal(requests[2].options.text, "Second paragraph.")
  assert.deepEqual(second.events, ["start", "start"], "restarted utterance reports onstart again")
  requests[2].resolve()
  await settle()
  assert.deepEqual(second.events, ["start", "start", "end"])
})

test("cancel clears the queue and silences settlements of stopped utterances", async () => {
  const { frameWindow, settle, requests, engine } = await setUp()
  const synth = frameWindow.speechSynthesis
  const first = trackedUtterance(frameWindow, "First paragraph.")
  const second = trackedUtterance(frameWindow, "Second paragraph.")
  synth.speak(first)
  synth.speak(second)
  await settle()

  synth.cancel()
  await settle()
  assert.equal(engine.stops, 1)
  assert.equal(synth.speaking, false)
  requests[0].reject(new Error("stopped"))
  requests[1].reject(new Error("stopped"))
  await settle()
  assert.deepEqual(first.events, ["start"], "cancelled playback reports nothing further")
  assert.deepEqual(second.events, [])

  // A fresh generation after cancel still works.
  const third = trackedUtterance(frameWindow, "Third paragraph.")
  synth.speak(third)
  await settle()
  assert.equal(requests.length, 3)
  assert.deepEqual(third.events, ["start"])
  requests[2].resolve()
  await settle()
  assert.deepEqual(third.events, ["start", "end"])
})

test("rate is clamped to the range native engines accept", async () => {
  const { frameWindow, settle, requests } = await setUp()
  const synth = frameWindow.speechSynthesis
  const fast = trackedUtterance(frameWindow, "Too fast.")
  fast.rate = 40
  synth.speak(fast)
  await settle()
  assert.equal(requests[0].options.rate, 6)
})

function createAdapterTarget() {
  const posts = []
  const listeners = []
  const parent = { postMessage: (message) => posts.push(message) }
  const target = {
    parent,
    addEventListener: (type, listener) => listeners.push(listener),
    document: { documentElement: { lang: "fr-FR" } },
    navigator: { language: "en-US" }
  }
  const dispatch = (data, source = parent) => {
    listeners.forEach((listener) => listener({ data, source }))
  }
  return { target, parent, posts, dispatch }
}

function loadAdapter() {
  const protocol = loadModule("apps/mobile/src/readerTtsProtocol.ts")
  const adapter = loadModule("apps/mobile/src/ReaderTtsAdapter.ts", {
    "./readerTtsProtocol": protocol
  })
  return { protocol, ...adapter }
}

test("adapter scopes callbacks to its parent and session", () => {
  const { READER_TTS_CHANNEL, READER_TTS_VERSION } =
    loadModule("apps/mobile/src/readerTtsProtocol.ts")
  const { ReaderTtsAdapter, BridgedSpeechSynthesisUtterance } = loadAdapter()
  const { target, posts, dispatch } = createAdapterTarget()
  const synth = new ReaderTtsAdapter(target, "reader-direct")
  const utterance = new BridgedSpeechSynthesisUtterance("Scoped")
  const events = []
  utterance.onstart = () => events.push("start")
  synth.speak(utterance)

  const start = {
    channel: READER_TTS_CHANNEL,
    version: READER_TTS_VERSION,
    sessionId: "reader-direct",
    type: "start",
    id: 1
  }
  dispatch(start, { postMessage: () => {} })
  dispatch({ ...start, sessionId: "reader-other" })
  assert.deepEqual(events, [])
  dispatch(start)
  assert.deepEqual(events, ["start"])
  assert.equal(posts[0].type, "voices")
  assert.equal(posts[1].type, "speak")
})

test("adapter owns voice routing, language fallback, and defensive voice snapshots", () => {
  const { READER_TTS_CHANNEL, READER_TTS_VERSION } =
    loadModule("apps/mobile/src/readerTtsProtocol.ts")
  const { ReaderTtsAdapter, BridgedSpeechSynthesisUtterance } = loadAdapter()
  const { target, posts, dispatch } = createAdapterTarget()
  const synth = new ReaderTtsAdapter(target, "reader-routing")
  const voices = [{
    voiceURI: "de-voice",
    name: "Vicki",
    lang: "de-DE",
    default: true,
    localService: true
  }]
  dispatch({
    channel: READER_TTS_CHANNEL,
    version: READER_TTS_VERSION,
    sessionId: "reader-routing",
    type: "voices",
    voices
  })
  const snapshot = synth.getVoices()
  snapshot.length = 0
  assert.equal(synth.getVoices().length, 1)

  const voiced = new BridgedSpeechSynthesisUtterance("Hallo")
  voiced.voice = synth.getVoices()[0]
  voiced.rate = Number.NaN
  synth.speak(voiced)
  assert.deepEqual(posts[1], {
    channel: READER_TTS_CHANNEL,
    version: READER_TTS_VERSION,
    sessionId: "reader-routing",
    type: "speak",
    id: 1,
    text: "Hallo",
    rate: 1,
    voice: 0,
    lang: "de-DE"
  })

  const fallback = new BridgedSpeechSynthesisUtterance("Bonjour")
  synth.speak(fallback)
  assert.equal(posts[2].lang, "fr-FR")
})

test("adapter reports active errors but cancellation resets state and ignores late errors", () => {
  const { READER_TTS_CHANNEL, READER_TTS_VERSION } =
    loadModule("apps/mobile/src/readerTtsProtocol.ts")
  const { ReaderTtsAdapter, BridgedSpeechSynthesisUtterance } = loadAdapter()
  const { target, posts, dispatch } = createAdapterTarget()
  const synth = new ReaderTtsAdapter(target, "reader-cancel")
  const errors = []
  const failing = new BridgedSpeechSynthesisUtterance("Fail")
  failing.onerror = (event) => errors.push(event.error)
  synth.speak(failing)
  dispatch({
    channel: READER_TTS_CHANNEL,
    version: READER_TTS_VERSION,
    sessionId: "reader-cancel",
    type: "error",
    id: 1,
    error: "native-failure"
  })
  assert.deepEqual(errors, ["native-failure"])
  assert.equal(synth.speaking, false)

  const cancelled = new BridgedSpeechSynthesisUtterance("Stop")
  cancelled.onerror = (event) => errors.push(event.error)
  synth.speak(cancelled)
  synth.pause()
  assert.equal(synth.paused, true)
  assert.equal(posts.at(-1).type, "cancel")
  synth.cancel()
  assert.equal(synth.paused, false)
  assert.equal(synth.speaking, false)
  dispatch({
    channel: READER_TTS_CHANNEL,
    version: READER_TTS_VERSION,
    sessionId: "reader-cancel",
    type: "error",
    id: 2,
    error: "interrupted"
  })
  assert.deepEqual(errors, ["native-failure"])
})
