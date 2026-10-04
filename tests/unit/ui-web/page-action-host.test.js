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
