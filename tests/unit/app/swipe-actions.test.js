const test = require("node:test")
const assert = require("node:assert/strict")
const {
  SWIPE_ACTION_LABELS,
  isSwipeActionId,
  listSwipeActions,
  onSwipeActionsChanged,
  registerSwipeAction,
  swipeActionLabel
} = require("../../../packages/app/dist/swipeActions")
const { normalizeSwipeSettings, DEFAULT_SWIPE_SETTINGS } = require("../../../packages/app/dist/swipeSettings")

test("built-in actions are listed first and labelled; unknown ids say so", () => {
  const ids = listSwipeActions().map((action) => action.id)
  assert.deepEqual(ids.slice(0, Object.keys(SWIPE_ACTION_LABELS).length), Object.keys(SWIPE_ACTION_LABELS))
  assert.equal(swipeActionLabel("skip"), "Skip")
  assert.equal(swipeActionLabel("addon:missing/thing"), "Unavailable add-on action")
})

test("an add-on action joins the choices, notifies, and leaves cleanly", () => {
  let changes = 0
  const stop = onSwipeActionsChanged(() => { changes += 1 })
  const remove = registerSwipeAction({ id: "addon:archive-today/open-archive", label: "Open archived copy" })
  assert.equal(changes, 1)
  assert.equal(swipeActionLabel("addon:archive-today/open-archive"), "Open archived copy")
  assert.equal(listSwipeActions().at(-1).id, "addon:archive-today/open-archive")
  assert.throws(() => registerSwipeAction({ id: "open", label: "Nope" }), /addon: ids/)
  remove()
  assert.equal(changes, 2)
  assert.equal(listSwipeActions().some((action) => action.id.startsWith("addon:")), false)
  stop()
})

test("settings keep add-on ids across sync even when the add-on is absent here", () => {
  assert.equal(isSwipeActionId("addon:archive-today/open-archive"), true)
  assert.equal(isSwipeActionId("addon:Bad/Id"), false)
  assert.equal(isSwipeActionId("nonsense"), false)
  const settings = normalizeSwipeSettings({
    ...DEFAULT_SWIPE_SETTINGS,
    right: ["addon:archive-today/open-archive", "nonsense"]
  })
  assert.deepEqual(settings.right, ["addon:archive-today/open-archive", DEFAULT_SWIPE_SETTINGS.right[1]])
})
