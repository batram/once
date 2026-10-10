const test = require("node:test")
const assert = require("node:assert/strict")
const nav = require("../../../packages/ui-web/dist/comments/commentNavigation")

// A thread in reading order:
//  0 a
//  1   a.1
//  2     a.1.1
//  3   a.2
//  4 b
//  5   b.1
//  6 c
const DEPTHS = [0, 1, 2, 1, 0, 1, 0]

/** Builds nav items with some comments collapsed, deriving `hidden` the way the view does. */
function items(collapsed = []) {
  let collapsedAt = -1
  return DEPTHS.map((depth, index) => {
    const hidden = collapsedAt >= 0 && depth > collapsedAt
    const isCollapsed = collapsed.includes(index)
    if (!hidden) collapsedAt = isCollapsed ? depth : -1
    return { depth, collapsed: isCollapsed, hidden }
  })
}

test("Down starts at the first comment, then walks siblings and climbs out", () => {
  const list = items()
  assert.equal(nav.nextIndex(list, -1), 0)
  assert.equal(nav.nextIndex(list, 0), 4, "skips a's replies")
  assert.equal(nav.nextIndex(list, 1), 3, "a.1 to its sibling a.2")
  assert.equal(nav.nextIndex(list, 2), 3, "a.1.1 climbs to a.2")
  assert.equal(nav.nextIndex(list, 3), 4, "a.2 climbs to b")
  assert.equal(nav.nextIndex(list, 6), -1, "nothing after the last")
})

test("Up goes to the previous comment at the same or a shallower level", () => {
  const list = items()
  assert.equal(nav.previousIndex(list, -1), -1)
  assert.equal(nav.previousIndex(list, 4), 0)
  assert.equal(nav.previousIndex(list, 3), 1)
  assert.equal(nav.previousIndex(list, 5), 4, "b.1 to its parent b")
})

test("Right steps into the first reply of an expanded comment", () => {
  const list = items()
  assert.deepEqual(nav.expandStep(list, 0), { expand: false, target: 1 })
  assert.deepEqual(nav.expandStep(list, 6), { expand: false, target: -1 }, "a comment without replies stays put")
})

test("Right expands a collapsed comment in place", () => {
  assert.deepEqual(nav.expandStep(items([0]), 0), { expand: true, target: 0 })
})

test("Left collapses and moves to the next expanded comment at this level or above", () => {
  assert.deepEqual(nav.collapseStep(items(), 0), { collapse: true, target: 4 })
  assert.deepEqual(nav.collapseStep(items([4]), 1), { collapse: true, target: 3 })
  // b is collapsed already, so a.2's next expanded peer-or-ancestor is c.
  assert.deepEqual(nav.collapseStep(items([4]), 3), { collapse: true, target: 6 })
})

test("Left on a collapsed comment goes to its parent", () => {
  assert.deepEqual(nav.collapseStep(items([1]), 1), { collapse: false, target: 0 })
  assert.deepEqual(nav.collapseStep(items([0]), 0), { collapse: false, target: -1 })
})

test("hidden replies are skipped by Down and Right", () => {
  const list = items([0])
  assert.equal(list[1].hidden && list[2].hidden && list[3].hidden, true)
  assert.equal(nav.nextIndex(list, 0), 4)
  assert.equal(nav.firstReplyOf(list, 0), -1)
})
