const test = require("node:test")
const assert = require("node:assert/strict")
const { parseHTML } = require("linkedom")
const { placeInOrder } = require("../../../packages/ui-web/dist/story/storyOrder")

function list(...ids) {
  const { document } = parseHTML(`
    <div id="stories"><div class="ptr-indicator"></div>${ids
      .map((id) => `<div class="story" id="${id}"></div>`)
      .join("")}</div>
  `)
  const container = document.querySelector("#stories")
  const row = (id) => container.querySelector(`#${id}`)
  const order = () => Array.from(container.children).map((child) => child.className === "story" ? child.id : "ptr")
  return { container, row, order }
}

test("an order that already holds moves nothing", () => {
  const { container, row, order } = list("a", "b", "c")
  assert.equal(placeInOrder(container, ["a", "b", "c"].map(row)), 0)
  assert.deepEqual(order(), ["ptr", "a", "b", "c"])
})

test("a newcomer appended at the end moves alone to its place", () => {
  const { container, row, order } = list("b", "c", "d", "a")
  assert.equal(placeInOrder(container, ["a", "b", "c", "d"].map(row)), 1)
  assert.deepEqual(order(), ["ptr", "a", "b", "c", "d"])
})

test("any order is reached and other children keep their place", () => {
  const { container, row, order } = list("a", "b", "c", "d", "e")
  placeInOrder(container, ["e", "c", "a", "d", "b"].map(row))
  assert.deepEqual(order(), ["ptr", "e", "c", "a", "d", "b"])
})
