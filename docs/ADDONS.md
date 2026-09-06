# Once add-ons

An add-on extends Once itself: story rows, story actions, the stories
toolbar, and the collectors that turn a URL into stories. It is not a browser
extension. Browser extensions (uBlock Origin, Violentmonkey, filter lists,
userscripts) run in the embedded browsers and are documented in
[ARCHITECTURE.md](ARCHITECTURE.md); add-ons run in Once's own UI, on every
platform, from one package. The design and its status are in
[plans/story-addons-plan.md](plans/story-addons-plan.md).

## A package

```
my-addon/
  once-addon.json   the manifest
  main.js           optional: an ES module, present when any contribution needs code
```

A user opens **Settings › Once Add-ons › Import addon…**, then uses **Import ZIP**,
**Import folder** where directory selection is supported, or the manifest URL.
Electron also offers **Load directory** to keep a local addon linked to its files.
The Once Add-ons overview lists installed and linked addons. Open a row for that addon's
settings and management controls; **Once Add-ons** in the header returns to the list.
Fields stay mounted while navigating, so unfinished settings edits are preserved.
The JSON editor and its Save/Cancel controls are hidden until you choose
**Advanced: edit addon JSON…** on the overview. Pasting manifests there remains supported. The
manifest is stored in the synced `addons` settings document and follows the
user's devices; the script is fetched per device, checked against the hash
the manifest pins, cached, and never synced. An add-on without a script is
purely declarative and needs no trust decision at all.

### Local ZIP and folder imports

Choose a ZIP containing exactly one `once-addon.json`, either at the archive root
or within a wrapping folder. The script must be included inside that package.
Local manifests may use `"script": "main.js"`, `{ "file": "main.js" }`, or
`{ "url": "main.js", "integrity": "sha256-…" }`. Once computes the script hash;
when the package declares one, it must match. Local imports never fetch missing
scripts from the network. The existing install preview shows the addon and its
permissions before **Confirm install** or **Apply update** activates it.

Imports are snapshots. Code is held in the existing device-local script cache,
while the manifest and ordinary settings sync as before. Import the package on
each device that needs to run it. Reimporting the same addon ID updates it while
preserving its enabled state, settings, and addon storage. No local file path is
synced. **Check for updates** applies to URL installations; reimport ZIP/folder
packages to update them.

ZIPs are limited to 8 MiB and 256 entries, with 8 MiB total expanded file sizes,
a 256 KiB manifest, and a 512 KiB script. Archive paths are validated; encrypted
archives and symbolic links are refused. Files are read in memory, not extracted
to disk. The single-script module model still applies: bundle script dependencies.
Folder imports use the same package limits.

### Linked directories in Electron

**Load directory** opens the native directory picker in both packaged and
development Electron builds. The chosen directory must contain `once-addon.json`
and its script, if any, using a plain local `.js` or `.mjs` filename. Once remembers
up to 16 picker-loaded directories on this device, reloads changed files, and
shows their settings alongside other addons. **Unload** removes the remembered
link and runtime contributions without deleting the original files or local
settings. Remove an installed copy with the same addon ID before loading a linked
directory. `ONCE_ADDONS` remains available for unpackaged development builds.

Browsers expose folder selection as a one-time import and do not offer Electron's
watched path. ZIP selection uses the platform file picker, including mobile where
available. Firefox's hosted sandbox requirement applies to every installation
method. ZIP decompression uses the browser's native compression streams.

## The manifest

```jsonc
{
  "protocol": 1,
  "id": "archive-today",              // 3–40 of a-z 0-9 -, unique by convention
  "name": "Archive.today",
  "version": "1.2.0",
  "author": "…",                       // optional
  "homepage": "https://…",             // optional, http(s)
  "script": {                          // optional; required when anything below asks the script
    "url": "main.js",                  // relative to the manifest, or absolute http(s)
    "integrity": "sha256-…"            // base64 sha256 of the exact bytes at url
  },
  "capabilities": ["fetch:https://*.archive.today/*"],   // optional grants, see below
  "settings": { "type": "object", "properties": { … } }, // optional user options
  "contributions": [ … ],              // story elements and actions
  "collectors": [ … ],                 // optional
  "panelActions": [ … ]                // optional, at most 4
}
```

A manifest is accepted whole or not at all; the editor names every problem
with its path (`contributions[0].run.open must start with http:// or
https://`). Every id an add-on introduces is shown and stored namespaced as
`addon:<addon-id>/<local-id>`, so two add-ons never collide and removing one
removes everything it added.

### The story view

Contributions never see Once's `Story` objects. They see a frozen view:
`href`, `redirectedHref` (after the user's redirect rules), `commentUrl`,
`title`, `type` (the collector badge), `domain` (of the redirected URL),
`timestamp` (ISO), `readState`, `stared`, `tags` (texts), `substories`, and
`fields`: the collector's extra scalar values, such as a score. Nothing about
the user's sources, filters, other stories, or sync.

### Conditions

Every contribution may carry `when`, evaluated by Once for each row:

| Key | Meaning |
| --- | --- |
| `type: ["HN"]` | any of these collector badges |
| `domain: ["example.org", "*.example.org"]` | host of the redirected URL; `*.` covers subdomains and the bare domain |
| `notDomain: [...]` | excluded hosts |
| `scheme: ["https"]` | scheme of the redirected URL |
| `tag: ["ask"]` | the story carries any of these tag texts |
| `readState: ["unread"]` | `unread`, `read`, or `skipped` |
| `stared: true` | bookmarked or not |
| `hasComments: true` | a comments URL exists |
| `field: { "score": 42 }` | collector extras equal to these values |

### Templates

Declarative `open`, `copy`, `search`, `text` values substitute `{href}`,
`{redirectedHref}`, `{commentUrl}`, `{title}`, `{domain}`, `{type}`,
`{timestamp}`, `{readState}`, and `{fields.<name>}`. In a URL every value is
percent-encoded and the result must be `http(s)`; a template that is not is
refused at save time.

### Story elements and actions (`contributions`)

```jsonc
{
  "kind": "action",
  "id": "open-archive",
  "label": "Open archived copy",
  "icon": "archive",                         // an icon name from Once's set
  "group": "navigation",                     // navigation | state | discovery | history | advanced
  "surfaces": ["button", "menu", "swipe", "key"],  // default: button and menu
  "when": { "scheme": ["http", "https"] },
  "run": { "open": "https://archive.today/newest/{href}", "target": "blank" }
}
```

One action appears on every surface it names: a button on the row, an entry
in the ⋮ menu (and the native menus), a choice in the swipe lab, and a
bindable command in the keyboard settings. `run` is one of:

| Run | Effect |
| --- | --- |
| `{ "open": url-template, "target": "_self" \| "blank" \| "middle" }` | opens the URL the way the menu would |
| `{ "copy": text-template }` | copies text |
| `{ "search": text-template }` | searches the story list |
| `{ "tag": "paywall" }` | adds a tag to the story |
| `{ "setReadState": "read" }` | `unread`, `read`, or `skipped`, through undo history |
| `{ "message": "name" }` | hands the invocation to the script (see below) |

Badges and lines render text on the row:

```jsonc
{ "kind": "badge", "id": "score", "when": { "type": ["HN"] }, "text": "{fields.score} pts" }
{ "kind": "badge", "id": "len", "compute": "len" }     // the script computes it
{ "kind": "line", "id": "note", "text": "via {domain}" }
```

### Collectors

```jsonc
{
  "id": "json",
  "type": "DJ",                        // 2–4 letters or digits; must not be a built-in's
  "description": "Demo JSON feed",
  "pattern": ["https://demo.test/api/*"],   // optional; detection, tried after every built-in
  "collects": "json",                  // dom | json | xml
  "colors": ["#336699", "white"],      // optional badge colours
  "cacheMinutes": 30,                  // optional
  "config": { "type": "object", "properties": { … } },   // optional, see Schemas
  "search": ["global", "domain"]       // optional; which searches the script implements
}
```

Once resolves the source, fetches, and caches exactly as for a built-in
collector, then hands the body to the script: the text for `dom` and `xml`
(parse it with `DOMParser` in the sandbox), the parsed value for `json`. The
script returns plain objects with `href`, `title`, and optionally
`comment_url`, `timestamp`, `filter`, `tags` (`[{ text, class?, href? }]`),
and scalar extras. Once checks them: `http(s)` URLs only, the collector's
declared `type`, at most 500 stories, capped lengths, scalar extras only.
Collectors always need a script. See [COLLECTORS.md](COLLECTORS.md) for how
the built-ins work; the same pipeline runs yours.

### Panel actions

```jsonc
{ "id": "count-feed", "label": "Count the feed", "icon": "reload", "run": { "message": "count-feed" } }
{ "id": "docs", "label": "Documentation", "run": { "open": "https://docs.example/" } }
```

Buttons in the stories toolbar, at most four. There is no story in hand, so
`open` takes a fixed URL and `message` runs without story operations.

### Schemas (`settings` and collector `config`)

A small subset of JSON Schema: `object` with `properties` and `required`,
`string` (`enum`, `maxLength`, `default`), `number` (`minimum`, `maximum`,
`default`), `boolean` (`default`), `array` (`items`, `maxItems`); nesting up
to three levels, at most 24 properties. Collector controls use `description`
as their label. Addon settings may provide `label`, `description` (help),
`group`, and `visibleWhen: { field, equals }` (string or boolean equality).
Once validates against the schema before anything reaches the script, fills
defaults, and drops undeclared fields. The manifest's `settings` schema is
rendered as controls in Settings › Once Add-ons › the addon name; the values reach the script as
`once.settings`. A collector's `config` schema is rendered in the source
editor: once a source names the collector, a Configuration group appears
under the Collector select with one row per property (nested objects and
arrays are edited as JSON), and Save stores the validated object in the
source's `select`, which `parse` receives as `config`. A value the schema
refuses is named in the form instead of being saved.

Addon string settings also support `format: "url"`, `"multiline"`, or
`"secret"`. Multiline settings can declare `maxLength: 16000`; collector
strings keep their existing 2000-character cap. Declared defaults have a
Restore default button. A secret cannot declare a default: its value is
excluded from options and `once.settings` and saved separately on this device.
Settings remain available while the addon is disabled. Development addon
options live locally by addon ID, independently of the synced manifest document.

### Capabilities

`capabilities` lists grants; shown at install. Only one kind exists:
`fetch:<match pattern>` allows `once.fetch` for matching URLs
(`https://api.example/*`, `*://*.example.org/*`; ports are ignored,
`http(s)` only). This GET-only API does not accept fetch init/options.
Separately, declared `connections` authorize requests to configured endpoints
as described below. An addon with neither fetch grants nor connections cannot
make arbitrary network requests of its own. Story content access is scoped to
the invoked story and can fetch that story through Once's reader pipeline.

### Connections and device-local credentials

Declare at most eight connections, for example:

```json
{
  "connections": [{ "id": "provider", "endpoint": "endpoint", "secret": "token", "auth": "bearer" }],
  "settings": { "type": "object", "properties": {
    "endpoint": { "type": "string", "format": "url", "label": "Request endpoint" },
    "token": { "type": "string", "format": "secret", "label": "API token" }
  } }
}
```

`endpoint` and `secret` name settings, not literal values. `auth` is `bearer`
(default) or `x-api-key`; `secret` is optional. The host injects the credential,
bound to the normalized full endpoint URL. Changing that URL requires replacing
the saved token. Tokens never travel into the sandbox or the synced document.
Browser storage is device-local, not equivalent to native OS encryption.

`once.request(id, { method?, headers?, query?, body? }, context?)` returns
`{ status, headers, text }`, including HTTP error statuses. Only GET/POST are
accepted; bodies are strings capped at 1 MiB UTF-8. Query values are strings
appended to the configured endpoint. Script headers are limited to Content-Type,
Accept, anthropic-version, and anthropic-workspace-id. Authentication and cookie
headers are host-owned. Responses expose Content-Type and Retry-After, with a
1 MiB body cap. Redirects are rejected. Transport errors do not expose credentials.

There are at most two active connection requests per addon, each with a 120-second
deadline. Pass the tray context (or use `context.request`) to cancel a particular
invocation; standalone requests are cancelled on settings changes or teardown.
Electron forwards cancellation through IPC. Capacitor's native HTTP API has no
cancel operation: Stop discards results while the native request finishes within
its timeout. Native mobile buffers the response before enforcing the size cap.

### Story trays

Declare up to four `trays: [{ id, title }]`, and give an ordinary story action
`run: { "tray": "the-tray-id" }`. The usual button/menu/key/swipe surfaces apply.
Once renders a full-width region below the story and owns all DOM and controls.

```js
once.onTray(async (tray, event, story, context) => {
  if (event.type === "clear") return { messages: [], composer: "Ask a question" }
  const article = await context.getStoryContent()
  const response = await context.request("provider", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: article.text, question: event.text })
  })
  context.signal.throwIfAborted()
  return { messages: [{ role: "assistant", text: response.text }], composer: "Ask a question" }
})
```

Events are `{ type: "open" | "clear" }`, `{ type: "submit", text }`, or
`{ type: "action", action }`. A view is
`{ messages, status?, statusTone?, actions?, composer? }`.
Messages have `role: "user" | "assistant" | "info"`, plain `text`, and optional
`sources: [{ title, url }]`; only HTTP(S) source links are allowed. Actions are
`{ id, label }`; the optional composer string labels the question field.
`statusTone` is `"info"` (the default) or `"error"`. An addon that catches its own
failures reports them through `status` like any other line, so set `"error"` there
or the host cannot tell a failure from progress and will render both alike.
Views are capped at 256,000 characters, 100 messages, 30 sources per message,
and eight actions. They never contain host HTML, scripts, or event handlers.

The host provides loading/error status, Retry, Stop, Close and Clear conversation.
Tray invocations last up to 120 seconds, with at most two active per addon.
The story and request identity scope every content operation and response. Stops,
settings changes, and teardown revoke pending work. Keep addon conversation state
in memory and clear it in `onSettings`; no persistence is needed for redraws.

`once.getStoryContent(story)` (or `context.getStoryContent()`) returns
`{ text, title, sourceUrl, origin: "stored" | "page", truncated }`. Once uses
saved/feed content first, otherwise fetches and extracts the article. Text is
capped at 64,000 characters. This does not mark the story read or save an offline
copy. Extraction errors reject the operation so the addon can label a title-only
answer rather than imply it read the article.

## The script

`main.js` is an ES module with a default export. It runs in a sandboxed
frame on an opaque origin, with no DOM of Once's, no network, and no storage
but what the API below provides. Its policy allows its own code and nothing
else. Keep it small: the cap is 512 KB.

```js
export default function activate(once) {
  once.onInvoke((action, story) => {
    if (action === "open-archive") once.openUrl(story, "https://archive.today/newest/" + story.href, "blank")
  })
  once.onBadges((contribution, stories) => stories.map((story) => `${story.title.length} chars`))
  once.onPanel(async (action) => {
    const response = await once.fetch(once.settings.feed)
    await once.storage.set("count", JSON.parse(response.text).items.length)
  })
  once.collectors.register("json", {
    parse(body, { url, config }) {
      return body.items.map((item) => ({ href: item.url, title: item.title, timestamp: item.at }))
    },
    globalSearch(needle) { /* optional */ }
  })
}
```

| Member | Purpose |
| --- | --- |
| `once.settings` | the user's options, defaults filled; `once.onSettings(fn)` announces changes |
| `once.onInvoke(fn(action, story))` | `message` story actions; `action` is the message name |
| `once.onBadges(fn(contribution, stories))` | computed badges; return one text per story, empty to show none |
| `once.onPanel(fn(action))` | `message` panel actions |
| `once.onTray(fn(tray, event, story, context))` | returns a validated host-rendered tray view |
| `once.getStoryContent(story)` | readable text for the invoked story |
| `once.request(connectionId, request, context?)` | bounded authenticated requests to a configured connection |
| `once.collectors.register(id, { parse, globalSearch?, domainSearch? })` | a collector declared in the manifest |
| `once.openUrl(story, url, target?)`, `once.copyText(story, text)`, `once.search(story, query)`, `once.notify(story, text)` | during an invocation, for the story it was about |
| `once.setReadState(story, state)`, `once.toggleBookmark(story)`, `once.addTag(story, tag)` | mutations on that story, through undo history |
| `once.updateBadge(story, contribution, text)` | later badge text for a story whose badge you computed |
| `once.fetch(url)` | GET within a `fetch:` grant; resolves `{ status, text }`, at most 1 MB |
| `once.storage.get(key)`, `once.storage.set(key, value)` | per-add-on storage in the synced document, 64 KB in total; keys are `[a-zA-Z0-9_.-]` |

Rules the host enforces, not the script:

- A story operation is accepted only while the request that raised it is
  open and only for the story it was about (or, for `updateBadge`, a story
  whose badge the add-on computed). Anything else is refused and logged.
- Requests time out: 3 s for an invocation, 5 s for a badge batch, 20 s for
  a collector parse, 15 s for a collector search, 120 s for a tray invocation.
- Three crashes or failed starts switch the add-on off on this device until
  Retry, an options change, or a changed manifest. Storage writes do not reset
  the failure count. Startup includes a deadline for loading the sandbox page.
- Answers are validated: badge texts are clipped to 60 characters, stories
  are checked as described above.

## Installing, updating, and where things run

- **Install from URL**: Settings › Once Add-ons › Import addon… › paste the URL of
  `once-addon.json` › Install › review its name, version and network access ›
  Confirm install. Code is hash-checked and, where a sandbox is available,
  trial-activated before the installed document changes. Trial storage writes
  are discarded. The entry remembers the URL. **Check for updates** shows
  candidates without installing them; **Apply update** verifies each candidate.
  Updates preserve enabled state and storage, and validate existing options
  against the replacement schema. An incompatible schema or failed package
  verification leaves the installed version intact.
- **Manage installed add-ons**: each entry shows its version and device status,
  with Enable/Disable, Remove and (for enabled scripts) Retry controls. Runtime
  status is local; installation, enabled state, options and storage are synced.
  Storage changes keep the sandbox alive. Options changes use `once.onSettings`
  and refresh computed badges; only definition changes rebuild registrations.
- **Paste**: the editor holds the whole document as a JSON list of
  manifests; add `"enabled": false` to switch one off. `options` and
  `storage` on an entry are yours and the script's respectively.
- **Code cache**: a script is fetched once per device and kept under its
  hash. A synced entry whose script cannot be fetched here is reported as
  installed elsewhere and stays off until it can be.
- **Developing one**: an unpackaged Electron build (`npm start`) reads
  `ONCE_ADDONS`, a PATH-style list of package directories, each holding
  `once-addon.json` beside its script. Write `"script": "main.js"` (a plain
  file name; the object form with a URL still works) and Once pins the hash
  itself, serves the file as `once-addon://dev/<n>/main.js`, registers the
  add-on beside the synced ones without writing it to the document, and
  reloads it when a file in the directory changes. A manifest problem is
  reported in the loader insights with the directory named. Packaged builds
  ignore the variable, like `ONCE_ELECTRON_EXTENSIONS`.
- **Platforms**: declarative add-ons run everywhere. Scripted add-ons run on
  Electron, mobile, and Chrome (the sandbox page is a manifest `sandbox`
  page of the extension). Firefox cannot run third-party code under an
  extension's origin, so there the Add-ons section asks for the `https` URL
  of a hosted copy of `addon-sandbox-hosted.html`, a self-contained page the
  Firefox build emits under `static/`; host it anywhere you trust, paste the
  URL, and reopen the sidebar (plain `http` is accepted from `127.0.0.1` and
  `localhost` only, for a copy served on your own machine). Until then Firefox
  reports scripted add-ons as unavailable and runs declarative ones only.

## Worked examples

Start with [Story length](../examples/addons/story-length/README.md), a small
package with typed script hints. `node scripts/validate-addon.js <directory>`
validates a local package and its pinned script without executing code or
accessing the network. The [editor schema](addon-manifest.schema.json) supplies
completion hints; the validator remains authoritative for semantic checks.
Authors can import `OnceAddonApi` from `@once/core` as a TypeScript type or a
JSDoc annotation. Keep the supplied story object across asynchronous work:
it carries the original invocation identity, including when handlers overlap.

The repository's e2e fixtures are complete, tested add-ons:

- `tests/e2e/shared/addon-fixture.js` is a script with a `message` action, a
  computed badge (with a settings-driven suffix), a panel action that fetches
  within its grant and stores the result, and a JSON collector.
- `tests/e2e/electron/addons.spec.js` holds the manifests that exercise it:
  a declarative add-on, a scripted one, a collector, an install from URL,
  and the capabilities case, each with the assertions that define correct
  behaviour.
