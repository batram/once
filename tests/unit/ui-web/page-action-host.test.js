const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const { parseHTML } = require("linkedom")
const { addonVaultReady } = require("../../../packages/ui-web/dist/addons/addonVaultGate")
const { bundledPageActions } = require("../../../packages/ui-web/dist/addons/bundledPageActions")

const tick = () => new Promise(resolve => setImmediate(resolve))
const root = () => parseHTML("<html><body><main></main></body></html>").document.querySelector("main")
const client = (state, unlock = async () => undefined) => {
  const unlocked = []
  return { unlocked, getAddonVaultStatus: async () => ({ state, message: `Vault is ${state}.`, protectedStorage: false }),
    unlockAddonVault: async (...args) => { unlocked.push(args); return unlock(...args) } }
}

test("the standalone host refuses panel search actions without running them or reporting success", async () => {
  const previous = { document: global.document, window: global.window, Event: global.Event }
  const dom = parseHTML("<html><body><main></main></body></html>")
  Object.assign(global, { document: dom.document, window: dom.window, Event: dom.Event })
  const mountPath = require.resolve("../../../packages/ui-web/dist/addons/mountAddons")
  const hostPath = require.resolve("../../../packages/ui-web/dist/addons/pageActionHost")
  const previousMount = require.cache[mountPath]
  const previousHost = require.cache[hostPath]
  const actions = require("../../../packages/ui-web/dist/addons/pageAddons")
  let release
  let runs = 0
  require.cache[mountPath] = { id: mountPath, filename: mountPath, loaded: true, exports: {
    mountAddons() {
      release = actions.registerPageAction({ id: "addon:example/search", label: "Search", surfaces: ["menu"],
        requiresPanel: true, appliesTo: () => true, run: () => { runs++; return true } })
    }
  } }
  Reflect.deleteProperty(require.cache, hostPath)
  try {
    const { hostPageAction } = require(hostPath)
    const host = dom.document.querySelector("main")
    const fakeClient = { ...client("disabled"), subscribe: () => () => {} }
    assert.equal(await hostPageAction(fakeClient, host, "addon:example/search",
      { href: "https://story.test/" }, { sandboxUrl: "sandbox.html", registrationMs: 50 }), false)
    assert.equal(runs, 0)
    assert.match(host.textContent, /Open the panel/)
    assert.doesNotMatch(host.textContent, /Done/)
  } finally {
    release?.()
    if (previousMount) require.cache[mountPath] = previousMount
    else Reflect.deleteProperty(require.cache, mountPath)
    if (previousHost) require.cache[hostPath] = previousHost
    else Reflect.deleteProperty(require.cache, hostPath)
    Object.assign(global, previous)
  }
})

// A tab running a page action without the panel reads the same stored
// add-ons; when they are in a locked vault it must ask, not report them missing.
test("readable add-on storage lets the page action run at once", async () => {
  for (const state of ["ready", "disabled", "unavailable"]) assert.equal(await addonVaultReady(client(state), root()), true)
})

test("a locked vault asks for its passphrase and runs once it opens", async () => {
  const host = root()
  const vault = client("locked", async secret => { if (secret !== "right") throw new Error("Wrong passphrase") })
  let ready
  void addonVaultReady(vault, host).then(value => { ready = value })
  await tick()
  const input = host.querySelector("input[type=password]")
  assert.ok(input, host.innerHTML)
  input.value = "wrong"
  host.querySelector("form").dispatchEvent(new host.ownerDocument.defaultView.Event("submit", { cancelable: true }))
  await tick()
  assert.equal(host.querySelector('[role="alert"]').textContent, "Wrong passphrase")
  assert.equal(ready, undefined)
  input.value = "right"
  host.querySelector("form").dispatchEvent(new host.ownerDocument.defaultView.Event("submit", { cancelable: true }))
  await tick()
  assert.equal(ready, true)
  assert.deepEqual(vault.unlocked.at(-1), ["right", false, false, ""], "the key is not remembered by a tab")
  assert.equal(host.children.length, 0)
})

test("a conflicted or broken vault is named instead of running without add-ons", async () => {
  for (const state of ["conflict", "error"]) {
    const host = root()
    assert.equal(await addonVaultReady(client(state), host), false)
    assert.match(host.textContent, new RegExp(`Vault is ${state}\\. Open the Once panel`))
  }
})

// The extension menus list these before any panel has loaded the add-on document.
test("the bundled What? Wait, who, why? package offers its menu action", async () => {
  const directory = path.resolve(__dirname, "../../../examples/addons/what-wait-who-why")
  const files = Object.fromEntries(["once-addon.json", "main.js"].map(name => [name, fs.readFileSync(path.join(directory, name), "utf8")]))
  assert.deepEqual(await bundledPageActions([{ files }, { files: { "once-addon.json": "not json" } }]),
    [{ id: "addon:what-wait-who-why/explain", label: "What? Wait, who, why?" }])
})
