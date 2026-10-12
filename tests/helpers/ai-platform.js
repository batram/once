const assert = require("node:assert/strict")
const { emptyAddonsDocument } = require("../../packages/core/dist")
const { AddonSync } = require("../../packages/app/dist/AddonSync")
const { AiService } = require("../../packages/app/dist/ai/AiService")

function aiPlatform(shared = new Map(), local = new Map()) {
  let counter = 0, document = emptyAddonsDocument(), failWrite = false
  const requests = []
  const platform = {
    listStore: {
      get: async (_id, fallback) => fallback, set: async () => {},
      readVault: async (id = "addon_vault") => structuredClone(shared.get(id) ?? []),
      writeVault: async (value, parents, id = "addon_vault") => {
        assert.deepEqual(parents, (shared.get(id) ?? []).map(item => item.revision))
        shared.set(id, [{ revision: `${++counter}-${crypto.randomUUID()}`, value: structuredClone(value) }])
      },
      dropVaultBranches: async (revisions, id = "addon_vault") => shared.set(id, (shared.get(id) ?? []).filter(item => !revisions.includes(item.revision)))
    },
    secretStore: { protection: "os", get: async key => local.get(key) ?? "", set: async (key, value) => { if (failWrite) throw new Error("disk full"); if (value) local.set(key, value); else local.delete(key) } },
    fetch: async (url, init) => { requests.push({ url, init }); return new Response(JSON.stringify({ choices: [{ message: { content: "Answer" }, finish_reason: "stop" }] }), { headers: { "content-type": "application/json" } }) }
  }
  const settings = { getAddons: async () => structuredClone(document), saveAddons: async value => { document = value }, updateAddons: async change => { document = change(document) } }
  const addons = new AddonSync(platform, settings, () => {})
  const ai = new AiService(platform, () => {}, addons.vault)
  return { platform, settings, addons, ai, shared, local, requests, failWrites(value) { failWrite = value } }
}
module.exports = { aiPlatform }
