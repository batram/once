/* global browser */
// Added to Violentmonkey's background page in the Android build. Violentmonkey
// accepts its dashboard commands only from its own pages, so Once cannot hand
// it scripts from outside the way Electron does from a virtual dashboard
// page. This relay is that page's stand-in: the app connects over native
// messaging, which only a built-in extension's background can open, and gets
// exactly the commands the hand-off uses — nothing that runs or reads a page.
// It also keeps the hand-off's records in Violentmonkey's own storage, under
// a key its vacuum leaves alone, so they cannot outlive the scripts they
// describe.
(() => {
  const COMMANDS = new Set([
    "ExportZip", "ParseScript", "GetScriptCode", "UpdateScriptInfo", "MarkRemoved", "RemoveScripts"
  ])
  const RECORDS_KEY = "onceUserscripts"
  const DEFAULTS_KEY = "onceDefaultsApplied"
  // Where Violentmonkey keeps each script's settings (`scr:`, which holds the
  // enabled switch) and text (`code:`). Stored values (`val:`) change with
  // every GM_setValue and are not part of what Once syncs.
  const SCRIPT_KEYS = /^(scr|code):/
  let port = null
  let inFlight = 0
  let changeTimer = null
  const epoch = `${Date.now()}-${Math.random()}`
  let revision = 0
  let snapshotKnown = false
  const invalidate = () => { revision++; snapshotKnown = false }
  const token = () => `${epoch}:${revision}`

  async function run({ cmd, data }) {
    if (cmd === "OnceReadSnapshot") {
      if (snapshotKnown && data?.token === token()) return { unchanged: true, token: token() }
      const before = revision
      const [records, scripts] = await Promise.all([
        browser.storage.local.get(RECORDS_KEY),
        globalThis.handleCommandMessage({ cmd: "ExportZip", data: { values: false } })
      ])
      snapshotKnown = before === revision
      return { records: records[RECORDS_KEY] ?? null, scripts, token: snapshotKnown ? token() : null }
    }
    if (cmd === "OnceReadRecords") return (await browser.storage.local.get(RECORDS_KEY))[RECORDS_KEY] ?? null
    if (cmd === "OnceWriteRecords") {
      invalidate()
      await browser.storage.local.set({ [RECORDS_KEY]: data })
      return null
    }
    if (!COMMANDS.has(cmd)) throw new Error(`Not a command Once hands to Violentmonkey: ${cmd}`)
    // Exported by Violentmonkey's background for its popup; it waits for the
    // background's own start-up before answering.
    if (!["ExportZip", "GetScriptCode"].includes(cmd)) invalidate()
    return globalThis.handleCommandMessage({ cmd, data })
  }

  // The runtime outlives the Android activity, and the app attaches its
  // delegate only once the engine is up, so a refused port is retried.
  function connect() {
    const connected = browser.runtime.connectNative("once_violentmonkey")
    port = connected
    connected.onMessage.addListener(message => {
      if (typeof message?.id !== "number") return
      const writing = ["OnceWriteRecords", "ParseScript", "UpdateScriptInfo", "MarkRemoved", "RemoveScripts"].includes(message.cmd)
      if (writing) inFlight++
      run(message).then(
        value => connected.postMessage({ id: message.id, value: value ?? null }),
        error => connected.postMessage({ id: message.id, error: String(error?.message ?? error) })
      ).finally(() => { if (writing) inFlight-- })
    })
    connected.onDisconnect.addListener(() => {
      if (port === connected) port = null
      setTimeout(connect, 1000)
    })
  }

  // Once's defaults, applied a single time so a later choice in the dashboard
  // stands. Synchronous page mode holds a page's response until its scripts
  // are ready: without it, a fast response can beat Violentmonkey's
  // prefetch and run `@run-at document-start` scripts late.
  async function applyDefaults() {
    if ((await browser.storage.local.get(DEFAULTS_KEY))[DEFAULTS_KEY]) return
    await globalThis.handleCommandMessage({ cmd: "SetOptions", data: { xhrInject: true } })
    await browser.storage.local.set({ [DEFAULTS_KEY]: 1 })
  }

  // An edit, toggle, install or removal made in Violentmonkey's dashboard is
  // announced so the app reconciles at once, as Electron does by watching the
  // same storage. Writes made while the app's own commands run are its own.
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return
    const scriptsChanged = Object.keys(changes).some(key => SCRIPT_KEYS.test(key))
    if (scriptsChanged || RECORDS_KEY in changes) invalidate()
    if (inFlight > 0 || !scriptsChanged) return
    clearTimeout(changeTimer)
    changeTimer = setTimeout(() => port?.postMessage({ type: "dashboard-changed" }), 500)
  })
  applyDefaults().catch(error => console.error("Once could not apply Violentmonkey defaults", error))
  connect()
})()
