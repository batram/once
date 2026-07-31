const assert = require("node:assert/strict")
const test = require("node:test")

const {
  semanticControlViolations
} = require("../../scripts/check-semantic-controls")

test("accepts the native button contract", () => {
  const source = `
    <button type="button" class="button">Save</button>
    <button type="button" class="button button--icon" aria-label="Reload"></button>
  `
  assert.deepEqual(semanticControlViolations("shell.html", source), [])
})

test("rejects legacy control alternatives", () => {
  for (const legacy of ["btn", "icon-btn", "sub"]) {
    assert.match(
      semanticControlViolations(
        "shell.html",
        `<div class="${legacy}"></div>`
      )[0],
      /prohibited legacy control class/
    )
  }
})

test("rejects non-native and unnamed button primitives", () => {
  assert.deepEqual(
    semanticControlViolations("shell.html", `
      <div class="button">Save</div>
      <button type="button" class="button button--icon"></button>
    `),
    [
      "shell.html applies .button to <div>",
      "shell.html contains an icon-only button without an accessible name"
    ]
  )
})

test("rejects clickable noninteractive HTML", () => {
  assert.deepEqual(
    semanticControlViolations("shell.html", `
      <div role="button">Open</div>
      <span onclick="openPanel()">Open</span>
    `),
    [
      "shell.html contains clickable noninteractive <div> markup",
      "shell.html contains clickable noninteractive <span> markup"
    ]
  )
})

test("requires explicit button types and rejects input buttons", () => {
  assert.deepEqual(
    semanticControlViolations("shell.html", `
      <button class="button">Save</button>
      <input type="button" value="Save">
    `),
    [
      "shell.html contains <input type=\"button\">",
      "shell.html contains a button without an explicit type"
    ]
  )
})
