const test = require("node:test")
const assert = require("node:assert/strict")
const { parseHTML } = require("linkedom")
const { trayMarkdown } = require("../../../packages/ui-web/dist/addons/trayMarkdown")

function render(text) {
  const previous = global.document
  const { document } = parseHTML("<html><body></body></html>")
  global.document = document
  try {
    const root = document.createElement("div")
    root.append(trayMarkdown(text))
    return root
  } finally { global.document = previous }
}

test("assistant Markdown renders headings, emphasis, nested lists, quotes and code", () => {
  const root = render("### Key Entities\n\n* **LLMs:** Text models with *context*.\n* Software\n  1. `tools`\n\n***\n\n> Evidence only.\n\n```js\nconst tag = '<b>'\n```\n\nFinal paragraph.")
  assert.equal(root.querySelector("h3").textContent, "Key Entities")
  assert.equal(root.querySelector("li strong").textContent, "LLMs:")
  assert.equal(root.querySelector("li em").textContent, "context")
  assert.equal(root.querySelectorAll("ul > li").length, 2)
  assert.equal(root.querySelector("ul ol li code").textContent, "tools")
  assert.equal(root.querySelectorAll("hr").length, 1)
  assert.match(root.querySelector("blockquote").textContent, /Evidence only/)
  assert.equal(root.querySelector("pre code").textContent, "const tag = '<b>'")
  assert.equal(root.querySelector("b"), null)
  assert.equal(root.lastElementChild.textContent, "Final paragraph.")
  assert.equal(render("`&amp; <tag>`").querySelector("code").textContent, "&amp; <tag>")
})

test("Markdown keeps HTML literal and renders images as text without creating active content", () => {
  const raw = '<b title="example">Literal HTML</b>'
  const root = render(`${raw}\n\n![Illustration](https://example.test/image.png)\n\n&lt;tag&gt; &amp; &#65;`)
  assert.ok(root.textContent.includes(raw))
  assert.ok(root.textContent.includes("Illustration"))
  assert.ok(root.textContent.includes("<tag> & A"))
  assert.equal(root.querySelector("b, img, script, iframe, input"), null)
})

test("only absolute HTTP(S) Markdown links without credentials become links", () => {
  const root = render("[**Source**](https://example.test/article?a=1&amp;b=2) [local](/settings) [mail](mailto:reader@example.test) [credentials](https://user:pass@example.test/) [scheme](javascript:void) https://example.test/plain")
  const links = root.querySelectorAll("a")
  assert.equal(links.length, 2)
  assert.equal(links[0].getAttribute("href"), "https://example.test/article?a=1&b=2")
  assert.equal(links[0].querySelector("strong").textContent, "Source")
  assert.equal(links[0].target, "_blank")
  assert.equal(links[0].rel, "noopener noreferrer")
  for (const label of ["local", "mail", "credentials", "scheme"]) assert.ok(root.textContent.includes(label))
})

test("tables, ordered starts, task lists and escaped Markdown remain readable", () => {
  const root = render("| Model | Use |\n| --- | --- |\n| **Lite** | Text |\n\n3. Third\n4. Fourth\n\n- [x] Done\n- [ ] Next\n\n\\*literal\\* and ~~old~~")
  assert.equal(root.querySelectorAll("th").length, 2)
  assert.equal(root.querySelector("td strong").textContent, "Lite")
  assert.equal(root.querySelector("ol").getAttribute("start"), "3")
  assert.ok(root.textContent.includes("☑ Done"))
  assert.ok(root.textContent.includes("☐ Next"))
  assert.ok(root.textContent.includes("*literal*"))
  assert.equal(root.querySelector("del").textContent, "old")
})
