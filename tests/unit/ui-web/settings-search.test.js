const test = require("node:test")
const assert = require("node:assert/strict")
const { parseHTML } = require("linkedom")

const {
  matchSettingsSection,
  settingsSearchSegments
} = require("../../../packages/ui-web/dist/settings/settingsSearch")

function withDom(html, callback) {
  const { window } = parseHTML(html)
  const previous = {
    HTMLInputElement: globalThis.HTMLInputElement,
    HTMLSelectElement: globalThis.HTMLSelectElement,
    HTMLTextAreaElement: globalThis.HTMLTextAreaElement
  }
  globalThis.HTMLInputElement = window.HTMLInputElement
  globalThis.HTMLSelectElement = window.HTMLSelectElement
  globalThis.HTMLTextAreaElement = window.HTMLTextAreaElement
  try {
    return callback(window.document.querySelector("section"))
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) Reflect.deleteProperty(globalThis, name)
      else globalThis[name] = value
    }
  }
}

test("matches section copy and current non-sensitive values", () => {
  withDom(`
    <section>
      <label>Minimum cache age <input type="number" value="42"></label>
      <textarea id="sources"></textarea>
      <select><option selected>Dark theme</option></select>
    </section>
  `, (section) => {
    section.querySelector("#sources").value =
      "news.example.test\nother.example.test"
    assert.deepEqual(matchSettingsSection(section, "Cache timing", "CACHE"), {
      matches: [],
      totalMatches: 0
    })
    assert.equal(
      matchSettingsSection(section, "Cache timing", "minimum").matches[0].text,
      "Minimum cache age"
    )
    assert.equal(
      matchSettingsSection(section, "Cache timing", "42").matches[0].text,
      "42"
    )
    const valueMatches =
      matchSettingsSection(section, "Cache timing", "example").matches
    assert.deepEqual(
      valueMatches.map(({ text, controlId, startIndex }) => ({
        text,
        controlId,
        startIndex
      })),
      [
        { text: "news.example.test", controlId: "sources", startIndex: 0 },
        { text: "other.example.test", controlId: "sources", startIndex: 18 }
      ]
    )
    assert.equal(
      matchSettingsSection(section, "Cache timing", "dark").matches[0].text,
      "Dark theme"
    )
  })
})

test("indexes canonical text settings without duplicating structured rows", () => {
  withDom(`
    <section>
      <textarea id="sources"></textarea>
      <div class="structured_settings">
        <button aria-label="Edit https://news.example.test/">
          <span>news.example.test</span>
          <span>https://news.example.test/</span>
        </button>
      </div>
    </section>
  `, (section) => {
    section.querySelector("#sources").value = "https://news.example.test/"
    const result = matchSettingsSection(section, "Story sources", "news.example")
    assert.equal(result.matches.length, 1)
    assert.deepEqual(result.matches[0], {
      text: "https://news.example.test/",
      controlId: "sources",
      startIndex: 0,
      endIndex: 26,
      targetId: undefined
    })
  })
})

test("filters mobile-only copy using the section document", () => {
  withDom(`
    <html><body data-platform="electron"><section>
      <span>Shared swipe copy</span>
      <span class="swipe_mobile_only">Mobile-only swipe copy</span>
    </section></body></html>
  `, (section) => {
    assert.ok(matchSettingsSection(section, "Swipe actions", "shared"))
    assert.equal(matchSettingsSection(section, "Swipe actions", "mobile-only"), null)
  })
})

test("never indexes the CouchDB URL or its masking presentation", () => {
  withDom(`
    <section>
      CouchDB Sync
      <div class="couch-container">
        <input id="couch_input" value="https://user:secret@example.test/db">
        <div class="couch-highlights">https://user:••••••@example.test/db</div>
      </div>
      <span id="couch_status">Failed to connect to secret-status.example.test</span>
      <span>Connection settings</span>
    </section>
  `, (section) => {
    const searchText = settingsSearchSegments(section)
      .map((segment) => segment.text)
      .join(" ")
    assert.doesNotMatch(searchText, /secret|example\.test|user/)
    assert.equal(matchSettingsSection(section, "CouchDB Sync", "secret"), null)
    assert.ok(matchSettingsSection(section, "CouchDB Sync", "settings"))
  })
})

test("returns no match for unrelated text and no details for a title match", () => {
  withDom("<section><span>Animation enabled</span></section>", (section) => {
    assert.deepEqual(
      matchSettingsSection(section, "Theme & animations", "THEME"),
      { matches: [], totalMatches: 0 }
    )
    assert.equal(matchSettingsSection(section, "Theme & animations", "redirect"), null)
  })
})

test("points error-log text matches at the containing expandable entry", () => {
  withDom(`
    <section>
      <div id="error_log">
        <details id="error-log-7" class="error_log_entry">
          <summary>HTTP Error</summary>
          <pre>A searchable connection failure</pre>
        </details>
      </div>
    </section>
  `, (section) => {
    const result = matchSettingsSection(
      section,
      "Error log",
      "searchable connection"
    )
    assert.equal(result.matches.length, 1)
    assert.deepEqual(result.matches[0], {
      text: "A searchable connection failure",
      targetId: "error-log-7",
      controlId: undefined,
      startIndex: undefined,
      endIndex: undefined
    })
  })
})
