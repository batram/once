const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const ts = require("typescript")
const { parseHTML } = require("linkedom")

function startupFixture() {
  const { document } = parseHTML(`<html><body>
    <main id="left_panel"></main>
    <div id="startup_status"><span id="startup_status_text"></span><button id="startup_retry"></button></div>
  </body></html>`)
  // Exercise the real startup renderer without booting Capacitor or a database.
  const filename = path.resolve(__dirname, "../../../apps/mobile/src/main.ts")
  const source = ts.createSourceFile(filename, fs.readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true)
  const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "showStartupState")
  assert.ok(declaration, "Mobile startup status renderer must exist")
  const code = ts.transpileModule(declaration.getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
  let reloads = 0
  const show = Function("document", "location", `${code}; return showStartupState`)(document, {
    reload() { reloads++ }
  })
  return { document, show, reloads: () => reloads }
}

for (const chosenPanel of ["reading", "settings"]) {
  test(`startup completion preserves a user's ${chosenPanel} tab`, async () => {
    const { document, show } = startupFixture()
    show("Preparing the application…")
    const panel = document.querySelector("#left_panel")
    assert.equal(panel.getAttribute("active_panel"), "stories", "Stories remains the launch default")
    show("Loading stories…")
    let finishLoading
    const loading = new Promise(resolve => { finishLoading = resolve }).then(() => show("Ready", "ready"))
    panel.setAttribute("active_panel", chosenPanel)
    finishLoading()
    await loading
    assert.equal(panel.getAttribute("active_panel"), chosenPanel)
    assert.equal(document.querySelector("#startup_status").hidden, true)
    assert.equal(document.querySelector("#startup_retry").hidden, true)
  })
}

test("startup progress and failure preserve navigation while retaining retry", () => {
  const { document, show, reloads } = startupFixture()
  show("Preparing the application…")
  const panel = document.querySelector("#left_panel")
  panel.setAttribute("active_panel", "reading")
  show("Opening saved stories and settings…")
  assert.equal(panel.getAttribute("active_panel"), "reading")
  show("Once could not finish starting.", "error")
  assert.equal(panel.getAttribute("active_panel"), "reading")
  const status = document.querySelector("#startup_status")
  const retry = document.querySelector("#startup_retry")
  assert.equal(status.dataset.state, "error")
  assert.equal(status.hidden, false)
  assert.equal(retry.hidden, false)
  assert.equal(document.querySelector("#startup_status_text").textContent, "Once could not finish starting.")
  retry.onclick()
  assert.equal(reloads(), 1)
})
