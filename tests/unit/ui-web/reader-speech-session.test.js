const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")
const ts = require("typescript")

const source = fs.readFileSync(path.resolve(
  __dirname,
  "../../../packages/ui-web/src/reader/ReaderSpeechSession.ts"
), "utf8")
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const sessionModule = { exports: {} }
Function("exports", "module", compiled)(sessionModule.exports, sessionModule)
const { ReaderSpeechSession } = sessionModule.exports

function createFixture() {
  const utterances = []
  const calls = []
  const voice = {
    voiceURI: "voice-1", name: "Reader", lang: "en", default: true, localService: true
  }
  const engine = {
    cancel: () => calls.push("cancel"),
    pause: () => calls.push("pause"),
    resume: () => calls.push("resume"),
    speak: (utterance) => utterances.push(utterance),
    getVoices: () => [voice]
  }
  const states = []
  const positions = []
  let claims = 0
  let releases = 0
  const session = new ReaderSpeechSession({
    engine,
    createUtterance: (text) => ({ text }),
    texts: ["one", "two", "three"],
    initialRate: 1.25,
    claimOwnership: () => { claims += 1 },
    releaseOwnership: () => { releases += 1 },
    onPositionChange: (position) => positions.push(position),
    onStateChange: (state) => states.push(state)
  })
  return {
    session, utterances, calls, states, positions,
    claims: () => claims, releases: () => releases
  }
}

test("reader speech session queues chunks and follows utterance lifecycle", () => {
  const fixture = createFixture()
  fixture.session.start(1)
  assert.equal(fixture.claims(), 1)
  assert.deepEqual(fixture.utterances.map(({ text }) => text), ["two", "three"])
  assert.equal(fixture.utterances[0].rate, 1.25)

  fixture.utterances[0].onstart()
  assert.deepEqual(fixture.positions, [1])
  assert.equal(fixture.session.state.segment, 1)
  fixture.utterances[1].onend()
  assert.equal(fixture.session.state.playing, false)
  assert.equal(fixture.session.state.segment, 0)
  assert.equal(fixture.releases(), 1)
})

test("reader speech session owns pause, restart, voice, and yielded position", () => {
  const fixture = createFixture()
  fixture.session.setVoice("voice-1")
  fixture.session.start()
  fixture.utterances[1].onstart()
  fixture.session.toggle()
  assert.equal(fixture.session.state.paused, true)
  fixture.session.toggle()
  assert.equal(fixture.session.state.paused, false)
  assert.deepEqual(fixture.calls.slice(-2), ["pause", "resume"])

  const queuedBeforePreview = fixture.utterances.length
  fixture.session.previewRate(1.75)
  assert.equal(fixture.session.state.rate, 1.75)
  assert.equal(fixture.utterances.length, queuedBeforePreview)
  fixture.session.setRate(2)
  assert.equal(fixture.session.state.rate, 2)
  assert.equal(fixture.utterances.at(-1).voice.voiceURI, "voice-1")
  fixture.session.yield()
  assert.equal(fixture.session.state.playing, false)
  assert.equal(fixture.session.state.segment, 1)
  assert.equal(fixture.positions.at(-1), 1)
})

test("reader speech session ignores stale and canceled utterance events", () => {
  const fixture = createFixture()
  fixture.session.start()
  const stale = fixture.utterances[0]
  fixture.session.next()
  stale.onstart()
  assert.equal(fixture.session.state.segment, 1)
  stale.onerror({ error: "canceled" })
  assert.equal(fixture.session.state.playing, true)
})

test("reader speech session arbitrates ownership and closes its channel", () => {
  let listener
  const posted = []
  let closed = false
  const engine = {
    cancel() {}, pause() {}, resume() {}, speak() {}, getVoices: () => []
  }
  const session = new ReaderSpeechSession({
    engine,
    createUtterance: () => ({}),
    texts: ["one"],
    initialRate: 1,
    ownerId: "mine",
    ownershipChannel: {
      postMessage: (message) => posted.push(message),
      addEventListener: (_type, handler) => { listener = handler },
      close: () => { closed = true }
    }
  })
  session.start()
  assert.deepEqual(posted, [{ type: "claim", ownerId: "mine" }])
  listener({ data: { type: "claim", ownerId: "other" } })
  assert.equal(session.state.playing, false)
  session.dispose()
  assert.equal(closed, true)
})
