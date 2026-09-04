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

A user installs an add-on by pasting the manifest's URL into Settings ›
Add-ons, or by pasting the manifest itself into the editor there. The
manifest is stored in the synced `addons` settings document and follows the
user's devices; the script is fetched per device, checked against the hash
the manifest pins, cached, and never synced. An add-on without a script is
purely declarative and needs no trust decision at all.

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
to three levels, at most 24 properties. `description` labels the control.
Once validates against the schema before anything reaches the script, fills
defaults, and drops undeclared fields. The manifest's `settings` schema is
rendered as controls in Settings › Add-ons; the values reach the script as
`once.settings`.

### Capabilities

`capabilities` lists grants; shown at install. Only one kind exists:
`fetch:<match pattern>` allows `once.fetch` for matching URLs
(`https://api.example/*`, `*://*.example.org/*`; ports are ignored,
`http(s)` only). An add-on without a `fetch:` grant provably makes no network
request of its own. Everything else a script can do is scoped to the story
the user acted on, so no other grant is needed.

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
  a collector parse, 15 s for a search.
- Three crashes or failed starts switch the add-on off until settings change.
- Answers are validated: badge texts are clipped to 60 characters, stories
  are checked as described above.

## Installing, updating, and where things run

- **Install from URL**: Settings › Add-ons › paste the URL of
  `once-addon.json` › Install. The entry remembers the URL; **Check for
  updates** refetches every such manifest and replaces entries whose version
  changed, keeping your enabled flag.
- **Paste**: the editor holds the whole document as a JSON list of
  manifests; add `"enabled": false` to switch one off. `options` and
  `storage` on an entry are yours and the script's respectively.
- **Code cache**: a script is fetched once per device and kept under its
  hash. A synced entry whose script cannot be fetched here is reported as
  installed elsewhere and stays off until it can be.
- **Platforms**: declarative add-ons run everywhere. Scripted add-ons run on
  Electron and mobile today. Firefox cannot host third-party code under an
  extension's origin, so it reports scripted add-ons as unavailable; Chrome
  will follow through its manifest `sandbox` mechanism.

## Worked examples

The repository's e2e fixtures are complete, tested add-ons:

- `tests/e2e/shared/addon-fixture.js` is a script with a `message` action, a
  computed badge (with a settings-driven suffix), a panel action that fetches
  within its grant and stores the result, and a JSON collector.
- `tests/e2e/electron/addons.spec.js` holds the manifests that exercise it:
  a declarative add-on, a scripted one, a collector, an install from URL,
  and the capabilities case, each with the assertions that define correct
  behaviour.
