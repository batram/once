const test = require("node:test")
const assert = require("node:assert/strict")
const { parseHTML } = require("linkedom")
const dialogs = require("../../../packages/ui-web/dist/confirmDialog")
const { bindSyncSettingReviewControls } = require("../../../packages/ui-web/dist/settings/syncSettingReviewControls")

const review = { id: "swipe", label: "Swipe settings", localRevisions: ["2-a", "2-b"], remoteRevision: "3-c",
  choices: [{ key: "remote", label: "Synced version", value: { list: { twoStage: false } } },
    { key: "2-b", label: "This device’s current version", value: { list: { twoStage: true, note: "<img src=x onerror=alert(1)>" } } }] }

function setup(t, client) {
  const previous = global.document
  global.document = parseHTML('<div id="sync_settings"></div>').document
  t.after(() => { global.document = previous })
  const show = bindSyncSettingReviewControls(client)
  show({ state: "error", message: "Review Swipe settings", settingReview: { documentId: "swipe" } })
  const panel = document.querySelector('[data-testid="sync-setting-review"]')
  const [load, save] = panel.querySelectorAll("button")
  return { show, panel, load, save }
}

test("settings review never selects automatically, escapes values and submits the reviewed revisions after confirmation", async t => {
  const calls = []
  t.mock.method(dialogs, "showConfirmDialog", async () => true)
  const { panel, load, save } = setup(t, { reviewSyncSetting: async () => review, resolveSyncSetting: async value => calls.push(value) })
  assert.equal(panel.hidden, false)
  assert.equal(save.disabled, true)
  await load.onclick()
  assert.equal(panel.querySelectorAll("input:checked").length, 0)
  assert.equal(panel.querySelector("img"), null)
  assert.match(panel.textContent, /Two Stage: No/)
  assert.equal(calls.length, 0)
  panel.querySelector('input[value="remote"]').onchange()
  assert.equal(save.disabled, false)
  await save.onclick()
  assert.deepEqual(calls, [{ id: "swipe", localRevisions: ["2-a", "2-b"], remoteRevision: "3-c", choice: "remote" }])
})

test("cancelling a choice or changing sync during confirmation never applies it", async t => {
  let applied = 0, confirm
  t.mock.method(dialogs, "showConfirmDialog", () => new Promise(resolve => { confirm = resolve }))
  const { show, panel, load, save } = setup(t, { reviewSyncSetting: async () => review, resolveSyncSetting: async () => applied++ })
  await load.onclick(); panel.querySelector("input").onchange()
  const cancelled = save.onclick(); confirm(false); await cancelled
  assert.equal(applied, 0)
  const stale = save.onclick()
  show({ state: "connecting", message: "Connecting elsewhere" })
  confirm(true); await stale
  assert.equal(applied, 0)
  assert.equal(panel.hidden, true)
})

test("stale resolution errors require a fresh review before another write", async t => {
  t.mock.method(dialogs, "showConfirmDialog", async () => true)
  const { panel, load, save } = setup(t, { reviewSyncSetting: async () => review,
    resolveSyncSetting: async () => { throw new Error("This setting changed while you were reviewing it") } })
  await load.onclick(); panel.querySelector("input").onchange(); await save.onclick()
  assert.match(panel.textContent, /changed while/)
  assert.equal(save.disabled, true)
  assert.equal(panel.querySelectorAll("input").length, 0)
})
