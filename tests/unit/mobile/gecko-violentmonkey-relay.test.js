const assert = require("node:assert/strict")
const crypto = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const vm = require("node:vm")

const root = path.resolve(__dirname, "../../..")
const { handUserscriptsToViolentmonkey, userscriptId } = require(path.join(root, "packages/core/dist/index.js"))
const { adaptGeckoViolentmonkey } = require(path.join(root, "scripts/adapt-gecko-violentmonkey.js"))
const relaySource = fs.readFileSync(path.join(root, "scripts/gecko-violentmonkey-relay.js"), "utf8")

const source = (name, body) => `// ==UserScript==
// @name ${name}
// @namespace once-test
// @match https://example.org/*
// ==/UserScript==
${body}`

/** Just enough of Violentmonkey's command table for the hand-off. */
function fakeViolentmonkey() {
  const scripts = new Map()
  const options = {}
  let nextId = 1
  const nameOf = code => /@name (.+)/.exec(code)[1]
  const commands = {
    ExportZip: () => ({ items: [...scripts.values()].map(script => ({
      script: { props: { id: script.id }, meta: { name: nameOf(script.code), namespace: "once-test" },
        config: { enabled: script.enabled ? 1 : 0, removed: script.removed ? 1 : 0 } },
      code: script.code
    })) }),
    ParseScript: ({ code }) => {
      const existing = [...scripts.values()].find(script => nameOf(script.code) === nameOf(code))
      const script = existing ?? { id: nextId++, enabled: true }
      script.code = code
      scripts.set(script.id, script)
      return { update: { props: { id: script.id } } }
    },
    GetScriptCode: id => scripts.get(id).code,
    UpdateScriptInfo: ({ id, config }) => { scripts.get(id).enabled = config.enabled === 1 },
    MarkRemoved: ({ id, removed }) => { scripts.get(id).removed = removed },
    RemoveScripts: ids => { for (const id of ids) scripts.delete(id) },
    SetOptions: values => Object.assign(options, values),
    // Never offered to the app: it would run code in a page.
    InjectionFeedback: () => "ran"
  }
  return { scripts, options, handleCommandMessage: async ({ cmd, data }) => commands[cmd](data) }
}

/** Runs the relay in a background page whose native port is `app`. */
function startRelay(violentmonkey, storage = {}) {
  const ports = []
  const timers = []
  const storageListeners = []
  vm.runInContext(relaySource, vm.createContext({
    console,
    setTimeout: callback => { timers.push(callback); return callback },
    clearTimeout: callback => { const index = timers.indexOf(callback); if (index >= 0) timers.splice(index, 1) },
    handleCommandMessage: violentmonkey.handleCommandMessage,
    browser: {
      storage: {
        local: {
          get: async key => key in storage ? { [key]: structuredClone(storage[key]) } : {},
          set: async values => Object.assign(storage, structuredClone(values))
        },
        onChanged: { addListener: listener => storageListeners.push(listener) }
      },
      runtime: { connectNative(name) {
        assert.equal(name, "once_violentmonkey")
        const port = { replies: new Map(), events: [],
          postMessage(message) {
            if (typeof message.id === "number") port.replies.get(message.id)(message)
            else port.events.push(message)
          },
          onMessage: { addListener(listener) { port.receive = listener } },
          onDisconnect: { addListener(listener) { port.disconnect = listener } } }
        ports.push(port)
        return port
      } }
    }
  }))
  let id = 0
  const send = (cmd, data) => new Promise((resolve, reject) => {
    const port = ports.at(-1)
    const message = { id: ++id, cmd, data }
    port.replies.set(message.id, reply => reply.error ? reject(new Error(reply.error)) : resolve(reply.value))
    port.receive(structuredClone(message))
  })
  const storageChanged = keys => {
    for (const listener of storageListeners) listener(Object.fromEntries(keys.map(key => [key, {}])), "local")
  }
  return { send, storage, ports, timers, storageChanged }
}

const digest = async value => crypto.createHash("sha256").update(value).digest("hex")

test("synchronous page mode is turned on once, and a later choice in the dashboard stands", async () => {
  const violentmonkey = fakeViolentmonkey()
  const relay = startRelay(violentmonkey)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(violentmonkey.options.xhrInject, true)
  violentmonkey.options.xhrInject = false
  startRelay(violentmonkey, relay.storage)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(violentmonkey.options.xhrInject, false)
})

test("the relay offers only the hand-off's commands", async () => {
  const relay = startRelay(fakeViolentmonkey())
  await assert.rejects(relay.send("InjectionFeedback", {}), /Not a command Once hands to Violentmonkey/)
  assert.deepEqual(await relay.send("ExportZip", { values: false }), { items: [] })
})

test("the relay reconnects when the app's delegate goes away", () => {
  const relay = startRelay(fakeViolentmonkey())
  relay.ports[0].disconnect()
  relay.timers.shift()()
  assert.equal(relay.ports.length, 2)
})

test("the relay announces script changes made in Violentmonkey's dashboard, not stored values", async () => {
  const relay = startRelay(fakeViolentmonkey())
  relay.storageChanged(["val:1"])
  assert.equal(relay.timers.length, 0, "GM_setValue writes are not script changes")
  // A toggle and an edit in quick succession are announced once.
  relay.storageChanged(["scr:1"])
  relay.storageChanged(["code:1"])
  assert.equal(relay.timers.length, 1)
  relay.timers.shift()()
  assert.equal(JSON.stringify(relay.ports[0].events), JSON.stringify([{ type: "dashboard-changed" }]))
})

test("the relay does not announce writes made by the app's own commands", async () => {
  const violentmonkey = fakeViolentmonkey()
  const handle = violentmonkey.handleCommandMessage
  const relay = startRelay({ handleCommandMessage: async message => {
    relay.storageChanged(["scr:1"])
    return handle(message)
  } })
  await relay.send("ExportZip", { values: false })
  assert.equal(relay.timers.length, 0)
})

test("synced scripts reach Violentmonkey through the relay, and dashboard edits come back", async () => {
  const violentmonkey = fakeViolentmonkey()
  const relay = startRelay(violentmonkey)
  const script = { id: userscriptId("once-test", "Greeter"), name: "Greeter", source: source("Greeter", "hello()"), enabled: true }
  const document = { version: 1, scripts: [script] }

  const first = await handUserscriptsToViolentmonkey(relay.send, document, {}, digest, true)
  await relay.send("OnceWriteRecords", first.applied)
  assert.equal(first.adopted, undefined)
  assert.equal([...violentmonkey.scripts.values()][0].code, script.source)

  // Edited in Violentmonkey's dashboard while the document stood still.
  const edited = source("Greeter", "goodbye()")
  ;[...violentmonkey.scripts.values()][0].code = edited
  const second = await handUserscriptsToViolentmonkey(relay.send, document, await relay.send("OnceReadRecords"), digest, true)
  assert.equal(second.adopted.scripts[0].source, edited)
  assert.ok(relay.storage.onceUserscripts[script.id], "records live in Violentmonkey's storage")

  // Dropped from the document: deleted from Violentmonkey too.
  await relay.send("OnceWriteRecords", second.applied)
  await handUserscriptsToViolentmonkey(relay.send, { version: 1, scripts: [] }, await relay.send("OnceReadRecords"), digest, true)
  assert.equal(violentmonkey.scripts.size, 0)
})

test("the Android copy adds the relay after Violentmonkey's background and reinstalls when it changes", () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "once-vm-"))
  const upstream = path.join(scratch, "violentmonkey")
  fs.mkdirSync(path.join(upstream, "background"), { recursive: true })
  fs.writeFileSync(path.join(upstream, "background/index.js"), '"use strict";{const e=!0,a=this;a.handleCommandMessage=Vm;({SetOptions(e){},xhrInject:e=>e})}')
  fs.writeFileSync(path.join(upstream, "manifest.json"), JSON.stringify({
    manifest_version: 2, version: "2.49.0", background: { scripts: ["background/index.js"] }, permissions: ["storage"]
  }))
  const target = path.join(scratch, "android", "violentmonkey")
  try {
    assert.equal(adaptGeckoViolentmonkey(upstream, target, "abc"), true)
    const manifest = JSON.parse(fs.readFileSync(path.join(target, "manifest.json"), "utf8"))
    assert.deepEqual(manifest.background.scripts, ["background/index.js", "once-relay.js"])
    assert.deepEqual(manifest.permissions, ["storage", "nativeMessaging", "geckoViewAddons"])
    assert.match(manifest.version, /^2\.49\.0\.\d+$/)
    assert.equal(fs.readFileSync(path.join(target, "once-relay.js"), "utf8"), relaySource)
    assert.equal(adaptGeckoViolentmonkey(upstream, target, "abc"), false, "an unchanged copy is kept")
    assert.equal(adaptGeckoViolentmonkey(upstream, target, "def"), true, "a new upstream is adapted again")

    fs.writeFileSync(path.join(upstream, "background/index.js"), '"use strict";')
    assert.throws(() => adaptGeckoViolentmonkey(upstream, target, "ghi"), /needs review/)
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
})

test("Android packages the adapted Violentmonkey and relays to it from a plugin of its own", () => {
  const java = path.join(root, "apps/mobile/android/app/src/main/java/com/zmarn/once")
  const engine = fs.readFileSync(path.join(java, "GeckoEngine.java"), "utf8")
  const relay = fs.readFileSync(path.join(java, "ViolentmonkeyRelayPlugin.java"), "utf8")
  const gradle = fs.readFileSync(path.join(root, "apps/mobile/android/app/build.gradle"), "utf8")
  assert.match(engine, /\{ "android\/violentmonkey", VIOLENTMONKEY_ID \}/)
  assert.match(gradle, /include\('ublock-origin\/\*\*', 'android\/violentmonkey\/\*\*'\)/)
  assert.match(gradle, /addGeneratedSourceDirectory\(onceExtensionAssets/)
  assert.match(relay, /ENV_TYPE_EXTENSION/)
  assert.match(relay, /setMessageDelegate\(RELAY, NATIVE_APP\)/)
})
