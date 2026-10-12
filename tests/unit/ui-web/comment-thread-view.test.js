const test = require("node:test")
const assert = require("node:assert/strict")
const { parseHTML } = require("linkedom")

function setup() {
  const { window } = parseHTML("<html><head></head><body></body></html>")
  for (const key of ["document", "HTMLElement", "DOMParser", "Event"]) global[key] = window[key]
  global.window = window
  window.getSelection ??= () => null
  // linkedom does no layout.
  window.HTMLElement.prototype.scrollIntoView ??= function () {}
  window.HTMLElement.prototype.focus ??= function () {}
  window.HTMLElement.prototype.getBoundingClientRect ??= () => ({ top: 0, bottom: 0 })
  global.getComputedStyle = () => ({ overflowY: "visible" })
  global.requestAnimationFrame = callback => setImmediate(callback)
  global.cancelAnimationFrame = () => {}
  return window.document
}

const doc = setup()
const { CommentThreadView, activeCommentThread } = require("../../../packages/ui-web/dist/comments/CommentThreadView")

const node = (id, children = [], extra = {}) => ({
  id, author: `user_${id}`, authorUrl: `https://site.test/u/${id}`, time: Date.now() - 3_600_000,
  html: `<p>comment ${id}</p>`, permalink: `https://site.test/c/${id}`, children, ...extra
})

function render(comments, extra = {}) {
  const opened = []
  const thread = { provider: "test", url: "https://site.test/s/1", title: "A story", total: 0, comments, fetchedAt: 0, ...extra }
  const view = new CommentThreadView(thread, { openUrl: (url, target) => opened.push([url, target]) })
  doc.body.replaceChildren(view.root)
  return { view, opened, ids: () => Array.from(view.root.querySelectorAll(".comment.is-current")).map(el => el.dataset.id) }
}

test("renders nested comments with header, body and permalink", () => {
  const { view } = render([node("a", [node("a1", [node("a11")]), node("a2")]), node("b")])
  const articles = Array.from(view.root.querySelectorAll(".comment"))
  assert.deepEqual(articles.map(el => el.dataset.id), ["a", "a1", "a11", "a2", "b"])
  assert.deepEqual(articles.map(el => el.dataset.depth), ["0", "1", "2", "1", "0"])
  const first = articles[0]
  assert.equal(first.querySelector(".comment_author").textContent, "user_a")
  assert.equal(first.querySelector(".comment_time").textContent, "1 hour ago")
  assert.equal(first.querySelector(".comment_permalink").getAttribute("href"), "https://site.test/c/a")
  assert.equal(first.querySelector(".comment_body").textContent, "comment a")
  assert.ok(first.querySelector(":scope > .comment_replies > .comment_rail"))
})

test("sanitizes comment bodies", () => {
  const { view } = render([node("x", [], { html: '<p onclick="evil()">hi<script>evil()</script><a href="javascript:evil()">j</a><a href="/rel">r</a></p>' })])
  const body = view.root.querySelector(".comment_body")
  assert.equal(body.querySelector("script"), null)
  assert.equal(body.querySelector("p").getAttribute("onclick"), null)
  const links = Array.from(body.querySelectorAll("a"))
  assert.equal(links[0].getAttribute("href"), null)
  assert.equal(links[1].getAttribute("href"), "https://site.test/rel")
})

test("keyboard moves follow the userscript and collapse hides replies", () => {
  const { view, ids } = render([node("a", [node("a1", [node("a11")]), node("a2")]), node("b")])
  view.next()
  assert.deepEqual(ids(), ["a"])
  view.expand()
  assert.deepEqual(ids(), ["a1"])
  view.next()
  assert.deepEqual(ids(), ["a2"])
  view.previous()
  view.collapse()
  const a1 = view.root.querySelector('[data-id="a1"]')
  assert.ok(a1.classList.contains("is-collapsed"))
  assert.equal(a1.getAttribute("aria-expanded"), "false")
  assert.equal(a1.querySelector(".comment_toggle").textContent, "[+1]", "counts only the hidden replies")
  assert.deepEqual(ids(), ["a2"], "moves on to the next expanded comment")
  view.previous()
  view.collapse()
  assert.deepEqual(ids(), ["a"], "Left on a collapsed comment goes to the parent")
  view.collapse()
  assert.deepEqual(ids(), ["b"])
  view.previous()
  view.expand()
  assert.equal(view.root.querySelector('[data-id="a"]').classList.contains("is-collapsed"), false)
})

test("a collapsed comment without replies shows no count", () => {
  const { view } = render([node("a")])
  const toggle = view.root.querySelector(".comment_toggle")
  assert.equal(toggle.textContent, "")
  toggle.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }))
  assert.ok(view.root.querySelector('[data-id="a"]').classList.contains("is-collapsed"))
  assert.equal(toggle.textContent, "")
})

test("a click on the header line collapses and expands a comment, one on its text only selects it", () => {
  const { view } = render([node("a", [node("a1")])])
  const click = selector => view.root.querySelector(`[data-id="a"] > .comment_main ${selector}`)
    .dispatchEvent(new Event("click", { bubbles: true, cancelable: true }))
  const collapsed = () => view.root.querySelector('[data-id="a"]').classList.contains("is-collapsed")
  click(".comment_body")
  assert.equal(collapsed(), false)
  assert.equal(view.selected, 0)
  click(".comment_body")
  assert.equal(collapsed(), false, "a double click on the text stays a word selection")
  click(".comment_time")
  assert.equal(collapsed(), true)
  click(".comment_head")
  assert.equal(collapsed(), false)
  click(".comment_author")
  assert.equal(collapsed(), false, "the author link opens instead")
})

test("links open through the shell, and the permalink key opens the selected comment", () => {
  const { view, opened } = render([node("a")])
  view.root.querySelector(".comment_author").dispatchEvent(new Event("click", { bubbles: true, cancelable: true }))
  view.next()
  view.openPermalink()
  assert.deepEqual(opened, [["https://site.test/u/a", "current"], ["https://site.test/c/a", "current"]])
})

test("marks the story author's comments as OP", () => {
  const { view } = render([node("a", [node("op", [], { author: "poster" })]), node("b")], { storyAuthor: "poster" })
  const op = view.root.querySelector('[data-id="op"]')
  assert.ok(op.classList.contains("is-op"))
  assert.equal(op.querySelector(".comment_op").textContent, "OP")
  assert.equal(view.root.querySelectorAll(".is-op, .comment_op").length, 2, "only the poster's comment")
})

test("removed comments keep their replies and say what happened", () => {
  const { view } = render([node("r", [node("child")], { author: null, html: "", removed: true })])
  const removed = view.root.querySelector('[data-id="r"]')
  assert.ok(removed.classList.contains("is-removed"))
  assert.equal(removed.querySelector(".comment_author").textContent, "[deleted]")
  assert.equal(removed.querySelector(".comment_removed").textContent, "[removed]")
  assert.ok(removed.querySelector('[data-id="child"]'))
})

test("the active thread is the one keys drive, until it is disposed", () => {
  const { view } = render([node("a")])
  view.activate()
  assert.equal(activeCommentThread(), view)
  assert.equal(view.root.dataset.keys, "on")
  view.dispose()
  assert.equal(activeCommentThread(), null)
})

test("held-back replies link to the site", () => {
  const { view } = render([node("a", [], { more: { count: 3, url: "https://site.test/c/a" } })], { more: { count: 5, url: "https://site.test/s/1" } })
  const links = Array.from(view.root.querySelectorAll(".comment_more")).map(el => el.textContent)
  assert.deepEqual(links, ["3 more replies on the site", "5 more comments on the site"])
})
