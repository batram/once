const test = require("node:test")
const assert = require("node:assert/strict")
const { parseHTML } = require("linkedom")

const { window } = parseHTML("<html><head></head><body></body></html>")
for (const key of ["document", "HTMLElement", "DOMParser", "Event"]) global[key] = window[key]
global.window = window
window.innerWidth = 400
window.getSelection ??= () => null
window.HTMLElement.prototype.scrollIntoView ??= function () {}
window.HTMLElement.prototype.focus ??= function () {}
window.HTMLElement.prototype.getBoundingClientRect ??= () => ({ top: 0, bottom: 0 })
global.getComputedStyle = () => ({ overflowY: "visible" })
global.requestAnimationFrame = callback => setImmediate(callback)
global.cancelAnimationFrame = () => {}

const { CommentThreadView } = require("../../../packages/ui-web/dist/comments/CommentThreadView")

const node = (id, children = []) => ({
  id, author: `user_${id}`, time: 0, html: `<p>comment ${id}</p>`, permalink: `https://site.test/c/${id}`, children
})

function render(foldDepth) {
  const thread = { provider: "test", url: "https://site.test/s/1", title: "A story", total: 0, fetchedAt: 0,
    comments: [node("a", [node("a1", [node("a11", [node("a111")])])])] }
  const view = new CommentThreadView(thread, { openUrl: () => {}, foldDepth })
  document.body.replaceChildren(view.root)
  return view
}

/** A horizontal swipe on the comment's text: +1 to the right, -1 to the left. */
function swipe(view, id, direction) {
  const target = view.root.querySelector(`[data-id="${id}"] > .comment_main > .comment_body p`)
  const touch = (type, x) => {
    const event = new window.Event(type, { bubbles: true })
    const point = [{ clientX: x, clientY: 100 }]
    event.touches = type === "touchend" ? [] : point
    event.changedTouches = point
    target.dispatchEvent(event)
  }
  touch("touchstart", 200)
  touch("touchmove", 200 + direction * 40)
  touch("touchend", 200 + direction * 100)
}

const swipeRight = (view, id) => swipe(view, id, 1)
const swipeLeft = (view, id) => swipe(view, id, -1)

const comment = (view, id) => view.root.querySelector(`[data-id="${id}"]`)
const bar = view => view.root.querySelector(".comment_context")

test("a swipe right on an open reply shows only it and its replies", () => {
  const view = render(true)
  swipeRight(view, "a11")
  assert.ok(view.root.classList.contains("is-focusing"))
  assert.ok(comment(view, "a11").classList.contains("is-focused"))
  assert.equal(bar(view).hidden, false)
  assert.equal(bar(view).querySelector(".comment_context_author").textContent, "user_a1")
  assert.equal(view.root.querySelector(".comment.is-current").dataset.id, "a11", "it does not step into the first reply")
  view.select(3)
  view.previous()
  view.previous()
  assert.equal(view.root.querySelector(".comment.is-current").dataset.id, "a11", "the keyboard stops where the hidden comments begin")
})

test("focusing a reply inside a focus goes one level, and the bar goes back one at a time", () => {
  const view = render(true)
  swipeRight(view, "a1")
  swipeRight(view, "a11")
  assert.ok(!comment(view, "a1").classList.contains("is-focused"))
  assert.ok(comment(view, "a11").classList.contains("is-focused"))
  const back = () => bar(view).dispatchEvent(new window.Event("click", { bubbles: true }))
  back()
  assert.ok(comment(view, "a1").classList.contains("is-focused"))
  assert.equal(bar(view).querySelector(".comment_context_author").textContent, "user_a")
  back()
  assert.ok(!view.root.classList.contains("is-focusing"))
  assert.equal(view.root.querySelectorAll(".is-focused").length, 0)
  assert.equal(bar(view).hidden, true)
})

test("a top-level comment focuses too, with the bar back to all comments", () => {
  const view = render(true)
  swipeRight(view, "a")
  assert.ok(comment(view, "a").classList.contains("is-focused"))
  assert.equal(bar(view).querySelector(".comment_context_author").textContent, "All comments")
  assert.equal(bar(view).querySelector(".comment_context_text").textContent, "")
  assert.equal(view.root.querySelector(".comment.is-current").dataset.id, "a", "it does not step into the first reply")
})

test("a swipe right on a collapsed comment still expands it", () => {
  const view = render(true)
  view.select(1)
  view.collapse()
  assert.ok(comment(view, "a1").classList.contains("is-collapsed"))
  swipeRight(view, "a1")
  assert.ok(!comment(view, "a1").classList.contains("is-collapsed"))
  assert.ok(!view.root.classList.contains("is-focusing"))
})

test("a swipe left on the focused comment collapses it and goes back one focus", () => {
  const view = render(true)
  swipeRight(view, "a1")
  swipeRight(view, "a11")
  swipeLeft(view, "a11")
  assert.ok(comment(view, "a11").classList.contains("is-collapsed"))
  assert.ok(comment(view, "a1").classList.contains("is-focused"), "back to the focus before")
  swipeLeft(view, "a1")
  assert.ok(comment(view, "a1").classList.contains("is-collapsed"))
  assert.ok(!view.root.classList.contains("is-focusing"))
  assert.equal(bar(view).hidden, true)
})

test("a swipe left on a reply inside the focus only collapses it", () => {
  const view = render(true)
  swipeRight(view, "a1")
  swipeLeft(view, "a11")
  assert.ok(comment(view, "a11").classList.contains("is-collapsed"))
  assert.ok(comment(view, "a1").classList.contains("is-focused"))
})

test("without folding, a swipe right on an open comment steps into its first reply", () => {
  const view = render(false)
  swipeRight(view, "a1")
  assert.equal(bar(view), null)
  assert.equal(view.root.querySelector(".comment.is-current").dataset.id, "a11")
  assert.equal(view.root.querySelector(".comment_focus"), null, "no reply count button either")
})

const focusButton = (view, id) => view.root.querySelector(`[data-id="${id}"] > .comment_main .comment_focus`)
const click = target => target.dispatchEvent(new window.Event("click", { bubbles: true }))

test("a comment with replies counts them all in a button, a comment without has none", () => {
  const view = render(true)
  assert.equal(focusButton(view, "a").textContent, "3 replies")
  assert.equal(focusButton(view, "a").getAttribute("aria-label"), "Show only this thread, 3 replies")
  assert.equal(focusButton(view, "a11").textContent, "1 reply")
  assert.equal(focusButton(view, "a111"), null)
})

test("the reply count focuses its comment, opening it first when collapsed", () => {
  const view = render(true)
  click(focusButton(view, "a1"))
  assert.ok(comment(view, "a1").classList.contains("is-focused"))
  assert.equal(view.root.querySelector(".comment.is-current").dataset.id, "a1")
  click(bar(view))
  view.select(2)
  view.collapse()
  assert.ok(comment(view, "a11").classList.contains("is-collapsed"))
  click(focusButton(view, "a11"))
  assert.ok(!comment(view, "a11").classList.contains("is-collapsed"))
  assert.ok(comment(view, "a11").classList.contains("is-focused"))
})
