const test = require("node:test")
const assert = require("node:assert/strict")
const { parseHTML } = require("linkedom")
const { bindAddonVaultControls } = require("../../../packages/ui-web/dist/settings/addonVaultControls")
const { addonCollectionSummary, requireAddonAvailability } = require("../../../packages/ui-web/dist/settings/addonAvailability")
const { bindAddonBundledImport } = require("../../../packages/ui-web/dist/settings/addonBundledImport")
const { configureBundledAddons } = require("../../../packages/ui-web/dist/addons/bundledAddons")
const { bundledAddons } = require("../../../scripts/bundled-addons")

test("conflict recovery guides an unlocked device without offering reinstall or claiming its collection is empty", async () => {
  const { document } = parseHTML('<html><body><button data-settings-target="addons"><span class="settings_section_summary"></span></button><div id="addon_install_settings"><div id="addon_overview"><button data-testid="open-addon-import"></button><button data-testid="update-addons"></button><div class="addon_list_row"></div></div></div></body></html>')
  const previous = global.document
  global.document = document
  const settle = () => new Promise(resolve => setImmediate(resolve))
  let state = "conflict", unlockRequired = false
  const listeners = []
  const client = {
    getAddonVaultStatus: async () => ({ state, unlockRequired, protectedStorage: true, message: state }),
    getAddons: async () => ({ version: 1, addons: [] }),
    getAddonVaultChoices: async () => [{ revision: "1-first", author: "Phone", updatedAt: "2026-09-30T12:00:00Z", addons: ["WWWW 1.6.0"], connections: [] }],
    resolveAddonVault: async (revision, expected) => {
      assert.equal(revision, "1-first")
      assert.deepEqual(expected, ["1-first"])
      state = "ready"
      listeners.forEach(listener => listener({ section: "addons" }))
    },
    subscribe: (_event, listener) => listeners.push(listener)
  }
  try {
    configureBundledAddons(bundledAddons())
    const root = document.querySelector("#addon_install_settings")
    bindAddonBundledImport(client, root, async () => assert.fail("must not offer a reinstall"))
    bindAddonVaultControls(client, document.querySelector("#addon_overview"))
    await settle()
    const vault = document.querySelector("#addon_vault_controls")
    const button = text => Array.from(vault.querySelectorAll("button")).find(item => item.textContent === text)
    assert.equal(vault.querySelector('input[type="password"]'), null)
    assert.equal(document.querySelector('[data-testid="open-addon-import"]').disabled, true)
    assert.equal(document.querySelector("#addon_bundled_import").hidden, true)
    assert.equal(addonCollectionSummary(), "1 add-on · Sync conflict")
    await assert.rejects(requireAddonAvailability(client), /have not been removed/)
    button("Review concurrent versions").click()
    await settle()
    assert.ok(button("Keep version from Phone"))
    button("Keep version from Phone").click()
    await settle()
    assert.equal(button("Keep version from Phone"), undefined, "stale choices disappear after resolution")
    assert.equal(vault.querySelector("details").open, false)
    assert.equal(addonCollectionSummary(), "1 add-on")
    assert.equal(document.querySelector('[data-testid="open-addon-import"]').disabled, false)
    await requireAddonAvailability(client)
    state = "conflict"; unlockRequired = true
    listeners.forEach(listener => listener({ section: "addons" }))
    await settle()
    assert.ok(vault.querySelector('[data-testid="addon-vault-secret"]'))
    assert.equal(button("Review concurrent versions"), undefined, "unlock comes before review on a locked device")
  } finally { global.document = previous }
})
