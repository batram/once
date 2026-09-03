# Plan: Once add-ons on every platform

Status: in progress. Steps 1 to 3 are done: the row element, story action,
and swipe action registries are open (the outline button is the first
built-in contribution, the Firefox `menus` mirror creates items for ids it
has not seen); the protocol's declarative half lives in
`packages/core/src/addons` (manifest validation, conditions, templates, the
story view, the `addons` document and its editor text); and the Add-ons
settings section saves manifests that contribute row buttons, badges, lines,
and actions on the menu, swipe, and key surfaces. Verified by unit tests and
an Electron e2e that saves a manifest, sees its button and badge on a row,
opens its templated URL, finds the action in the swipe lab and the keybinding
editor, and watches everything leave when the add-on is switched off.
Manifests with a `script` are refused until step 4.

## Decision

Once gets **add-ons**: packages of its own format that extend the reader
itself. They are separate from the WebExtensions the embedded browsers host
(uBlock Origin, Violentmonkey) and never touch that runtime, its allowlist,
or `browser.*`. In settings and documentation "Extensions" keeps meaning
browser extensions and their filter lists and userscripts; "Add-ons" means
additions to Once.

An add-on can contribute:

- **collectors**: a parser for a new kind of source, optionally with search
  and a configuration schema, so users can add sources Once does not know;
- **story elements**: an icon button on a row, a badge on the title line, an
  extra line under the title;
- **story actions**: one contribution that appears as a ⋮ menu entry, a swipe
  action, and a bindable key command;
- **panel actions**: a button in the stories toolbar;
- **settings**: typed options the add-on declares and Once renders in its own
  settings section.

An add-on is one package that behaves identically on Firefox, Chrome,
Electron, Android, and iOS. That is the reason for a format of our own: the
code runs in a sandbox Once controls on every target, speaks one protocol,
and never enters the Once document. Add-ons without code (declarative
contributions only) need no sandbox at all and are just a synced setting.

## What exists today, and what the design leans on

Each item below is already the shape an extension point needs; the plan
generalises them rather than adding a parallel system.

**Collectors.** `packages/collectors/src/registry.ts` hard-codes eight
`StoryParser` objects in `get_active()`: `options {id, type, description,
pattern, collects: dom|json|xml, colors, cache_minutes, settings}`,
`parse(input, {url, config})`, optional `normalizeConfig`,
`serializeConfig`, `global_search`, `domain_search`. `options.id` is a public
persistence identifier stored in `StorySource.collector`
(`core/src/settings/storySource.ts`), frozen by
`tests/unit/collectors/registry-ids.test.js`. `SourceLoader` resolves the
collector first (`resolveStorySource`), fetches through the platform `fetch`
port, reads or writes the cache keyed on the URL, decodes by `collects`
(`parse_dom` / `parse_xml` with a `<base>` installed), and calls `parse`.
Configurable collectors validate untrusted configuration through
`sanitize_selector_conf` with hard caps (COLLECTORS.md). Search providers are
gathered by `global_search_providers()` and used in `story/storySearch.ts`.
The source picker produces `{conf, url}` for Geny Match only.

**Story row.** `presenters/registry.ts` is a hard-coded list of presenters
whose `story_elem_button(story)` is appended to `button_group`, gated by
`story_button: always|handled|never`. `storyRowMarkup.createIconButton` is
the shared button shape. Rows expose `href`, `title`, `type`, `comment_url`,
`timestamp`, `redirected_url` as `data-*`.

**Story actions.** `menu/storyContextMenu.ts`: closed union
`StoryMenuActionId`, `describeStoryMenu(context)` returning
`{id, label, group, enabled, visible}` descriptors, one
`executeStoryMenuAction(id, row)` switch. Three renderers consume the
descriptors: the DOM anchored menu, Electron's native menu, the mobile
native menu; the Firefox `menus` mirror in `webext-shell` hard-codes its own
copy of the list. `app/src/swipeSettings.ts` has the closed `SwipeActionId`
union; `story/swipe/commit.ts` routes through the menu executor.
`keyboard/commands.ts` is a real registry (`registerKeyCommand` with
`shells: electron|webext|mobile`), and `storyActionCommands.ts` says in its
header that this is "the pattern a plugin will follow".

**Platform ports.** `OncePlatformPorts` (`app/src/types.ts`): `listStore`,
`storyStore`, `cacheStore`, `fetch`, `activeTab`, `theme`, sync. `fetch` is
`bridgeFetch` through the main process on Electron (`net.fetch`), plain
`fetch` under `<all_urls>` on the extensions, and `window.fetch` on mobile.
`OnceClient` exposes `persistStoryChange`, `openUrl`, `addFilter`,
`selectUrl`, `fetchDocument`, `subscribe`.

**Settings documents.** `PouchListStore` stores `{_id, list}` documents;
`filter_lists` and `userscripts` show the versioned-document pattern with a
tolerant reader and a text editor in the shared panel. Settings sections are
blocks in `packages/ui-web/public/shell.html` that `SettingsPanel` wraps and
indexes; a block that stays hidden drops its section.

**Sandboxing already in the Once document.** `reader/ReaderDocumentHost.ts`
opens reader articles in an `<iframe sandbox="allow-scripts">` with `srcdoc`.
Because a `srcdoc` frame inherits the parent's CSP, the reader runtime is
inlined and whitelisted by sha256 at build time (`ReaderRuntimeCspPlugin`).
The shared shell CSP is `script-src 'self'; frame-src 'self' blob:;
connect-src 'self' http: https:`. Electron serves its own schemes
(`once-reader://`) through `protocol.handle` with `standard`, `secure`,
`supportFetchAPI` privileges. Mobile serves the app from Capacitor's local
server. ARCHITECTURE.md lists four trust zones; add-on sandboxes become the
fifth.

## Package format

```
my-addon/
  once-addon.json      manifest
  main.js              optional; present iff any contribution needs code
  icons/*.svg          optional; referenced by name from the manifest
  _locales/*.json      optional; labels as message keys, Once's i18n tables
```

Manifest, abridged:

```jsonc
{
  "protocol": 1,
  "id": "lemmy",                    // [a-z0-9-], 3–40 chars, globally unique by convention
  "name": "Lemmy",
  "version": "1.0.0",
  "author": "…", "homepage": "https://…",
  "script": "main.js",              // omit for declarative add-ons
  "collectors": [ … ],
  "storyElements": [ … ],
  "storyActions": [ … ],
  "panelActions": [ … ],
  "settings": { … },                // JSON-schema subset; Once renders the controls
  "capabilities": ["fetch:https://*.lemmy.world/*"]   // only what code needs; empty for declarative
}
```

Every id an add-on introduces is namespaced by Once as
`addon:<addon-id>/<local-id>`: collector ids stored in sources, action ids
in menus and key bindings, setting keys in the synced document. Namespacing
is what lets an add-on be removed cleanly and what keeps two add-ons from
colliding.

## Execution model: the add-on sandbox

Code add-ons run in **one sandboxed document per add-on**, hosted by the Once
UI in an `<iframe sandbox="allow-scripts">`, so the origin is opaque, there
is no DOM access to Once, no storage of its own, and no network unless the
host performs it. Inside, a small **sandbox runtime** shipped with Once
loads the add-on's `main.js`, hands it a `once` object implementing the
protocol below, and relays messages with `postMessage`. Collectors need
`DOMParser`, which is why this is a document and not a Worker; the same
choice gives one runtime for every contribution kind.

The one thing that differs per target is **how the sandbox page is served**,
because a `srcdoc` or `blob:` document inherits the host CSP
(`script-src 'self'`) and would refuse the add-on's code. Each target serves
a static `addon-sandbox.html` from a place where it carries its own policy:

| Target | Serving | Notes |
| --- | --- | --- |
| Firefox, Chrome | Manifest `sandbox.pages: ["static/addon-sandbox.html"]` | The platforms' own mechanism for exactly this: an opaque-origin page with a separate `content_security_policy.sandbox` that permits `blob:` scripts, no extension APIs, no access to the opener. |
| Electron | `once-addon://<id>/addon-sandbox.html` via `protocol.handle` | Sibling of `once-reader://`; the response carries `Content-Security-Policy: sandbox allow-scripts; script-src 'self' blob:`. The renderer's `frame-src` gains the scheme. |
| Android, iOS | A route on the app's local server (`/once-addon/sandbox.html`) answered by the Capacitor plugin with the same CSP header | Android through `shouldInterceptRequest` in the existing plugin, iOS through Capacitor's scheme handler. The route serves the static page only; add-on code still arrives by `postMessage`. |

The add-on's code reaches the sandbox as text over `postMessage`; the
runtime turns it into a `blob:` module and imports it. That keeps code out
of any URL Once serves and lets one static page host any add-on. The
sandbox page's own CSP is the whole permission set: `connect-src 'none'`,
`img-src 'none'`, no forms, no popups, no top navigation.

Lifecycle: created lazily on the first contribution that needs it, kept while
the add-on is enabled and the UI is open, restarted on crash with a diagnostic
in the loader insights line, torn down on disable. Every request has a
timeout (3 s for UI invocations, 20 s for a collector parse) and a
per-add-on budget for concurrent badge computations. On Electron the
sandboxes live in the trusted renderer's process as frames; that is the
same isolation the reader already relies on, and enough for code that has no
capabilities beyond what the host grants.

## The protocol

JSON messages over `postMessage`, versioned by `protocol`. The `core`
package owns the types and the pure functions (manifest validation,
condition evaluation, template rendering, story-view projection, story
result validation); `app` owns the registry, the sandbox broker, and
dispatch; `ui-web` renders; `platform-*` serve the sandbox page.

**Handshake.** Host → sandbox: `{type: "load", code, manifest, settings,
locale}`. Sandbox → host: `{type: "ready", protocol, contributions?}`.
Contributions beyond the manifest's static ones may be added at `ready`
(for example, a collector whose patterns depend on settings).

**Host → add-on requests** (each with `requestId`, answered or timed out):

| Request | Purpose |
| --- | --- |
| `collector.normalizeConfig {collector, raw}` | validate and canonicalise configuration; declarative schema in the manifest runs first, this runs only if declared |
| `collector.parse {collector, url, body, mediaType, config}` | body is text (or the JSON value for `collects: "json"`); returns plain story objects |
| `collector.search {collector, kind: "global"|"domain", needle}` | returns story objects; the host fetches nothing for it, the add-on asks through `once.fetch` |
| `story.invoke {action, story}` | a `run: {message}` story action |
| `panel.invoke {action}` | a panel button |
| `story.badges {contribution, stories[]}` | compute badge text for visible rows; batched, budgeted |
| `settings.changed {values}` | the user edited the add-on's options |

**Add-on → host operations** (`once.*` inside the sandbox):

| Operation | Grant |
| --- | --- |
| `fetch(url, init)` | only with `capabilities: ["fetch:<match pattern>"]`; performed by the host through the platform `fetch` port (so Electron's main-process fetch and the extensions' host permissions apply), response size and time capped, credentials never sent |
| `openUrl(url, target)` | `http(s)` only; the menu's targets |
| `copyText(text)`, `search(query)`, `notify(text)` | inside an invocation only |
| `setReadState`, `toggleBookmark`, `addTag(tag)` | on the story of the current invocation only; through `persistStoryChange`, so undoable |
| `storage.get/set(key, value)` | a per-add-on namespace in the synced `addons` document, size-capped; this is how an add-on keeps a cursor or a token |
| `updateBadge(storyHref, contribution, text)` | asynchronous badge results |
| `log(level, text)` | to the diagnostics log, prefixed with the add-on id |

There is no message that hands an add-on the story list, another add-on's
data, sources, filters, or sync credentials.

**Story view.** A frozen projection, never the `Story` instance: `href`,
`redirectedHref`, `commentUrl`, `title`, `type`, `timestamp`, `readState`,
`stared`, `tags`, `substories[] {title, commentUrl, type}`, and `fields`
(collector extras that are strings, numbers, or booleans).

## Collector add-ons

The registry becomes composable: `get_active()` returns the built-ins
followed by every enabled add-on collector, each wrapped in a `StoryParser`
whose `parse` and search functions are protocol calls. Everything
`SourceLoader`, `resolveStorySource`, cache maintenance, the search box, and
the settings editors know about collectors keeps working unchanged, because
the wrapper honours the same interface.

- **Identity.** `options.id` is `addon:<addon>/<collector>`; sources that
  name it store that string. The frozen-id test stays for built-ins;
  add-on ids are frozen by the add-on's own manifest.
- **Detection.** Add-on `pattern`s are matched after every built-in, so an
  add-on cannot capture `news.ycombinator.com`. A user who wants that names
  the collector explicitly in the source.
- **Fetching stays in the host.** The loader fetches and caches exactly as
  today and sends the body text to the sandbox; `collects: "dom"` collectors
  parse it with the sandbox's own `DOMParser` and a `<base>` the runtime
  installs, mirroring `parse_dom`. Nothing in `parse` may fetch; a collector
  that needs a second request declares `fetch:` capability and does it in
  `search` or a `prepare` step, the way built-in search providers are the
  explicit asynchronous exception.
- **Configuration.** The manifest declares a `config` schema (a JSON-schema
  subset: object, string, number, boolean, enum, array with caps, required).
  Once validates against it before anything reaches the add-on, and renders
  the source editor's configuration fields from it, which is more than the
  built-in configurable collectors get today. `collector.normalizeConfig` is
  optional and runs after the schema.
- **Results.** Plain objects; the host runs `Story.assertIngestible`, caps
  story count and string lengths, requires `http(s)` hrefs and comment URLs,
  drops unknown fields except a bounded `fields` bag, and sets `type` to the
  collector's declared `type` (a 2–4 character badge, unique across the
  registry at registration or the add-on is rejected).
- **Search.** `global_search` / `domain_search` become protocol calls; the
  search box already iterates providers.
- **Picker.** A collector may declare `"picker": "selector"` to say its
  configuration is a Geny-style selector set; the existing picker then
  offers it as a target. Anything richer waits.
- **Cache windows** come from `options.cache_minutes` in the manifest, as
  today.
- **Coexistence with the WebExtension bridges.** None: collectors run in
  the Once UI's sandbox on every target. On Android and iOS this is the
  Capacitor WebView, not GeckoView or the reading surface.

## UI add-ons

Rows and menus never render add-on HTML. Contributions are declared
primitives, and the host draws them with its own components, so an add-on
button is indistinguishable from the outline button.

- **Story elements**: `button {icon, label, action}`, `badge {text |
  computed}`, `line {text}`; each with a `when` condition over the story
  view (`type`, `domain`/`notDomain`, `scheme`, `tag`, `readState`,
  `stared`, `hasComments`, `field` equality). Conditions are evaluated by
  the host, so rows never wait on a sandbox.
- **Story actions**: `{id, label, icon, group, surfaces: button|menu|swipe|key,
  when, run}`. `run` is declarative (`open` URL template, `copy`, `search`,
  `tag`, `setReadState`) or `{message}` for code. Templates substitute
  `{href}`, `{redirectedHref}`, `{commentUrl}`, `{title}`, `{domain}`,
  `{type}`, `{timestamp}`, `{fields.<name>}`, URL-encoded in URL position;
  results must be `http(s)`. Registration: menu descriptors gain an add-on
  group; `SwipeActionId` and `StoryMenuActionId` become open strings backed
  by descriptor registries; `registerKeyCommand` under group `addons`; the
  Firefox `menus` mirror reads descriptors instead of its own list.
- **Panel actions**: a toolbar button with `{label, icon, run}`, capped at a
  few per add-on; hidden on `mobile` unless the add-on marks it
  touch-friendly.
- **Settings**: the manifest's `settings` schema is rendered inside one
  "Add-ons" section as a group per add-on (enable toggle, version, source,
  the declared controls, errors). Values live in the synced document and
  reach the sandbox as `settings.changed`.
- **Icons**: names from Once's icon set, or the add-on's own SVG files under
  a size cap, sanitised (no scripts, no external references) and inlined as
  `data:` masks.
- **Reader post-processing and theming** are not in this plan; they need
  their own trust analysis because they touch rendered documents.

## Sync, storage, and installation

- **`addons` document**, version 1, synced like every other setting: for
  each installed add-on `{id, version, enabled, source: {url | "file" |
  "dev"}, integrity: "sha256-…", settings: {...}, storage: {...}}` plus the
  declarative manifests for add-ons without code. Tolerant reader; unknown
  add-ons on another device stay listed as "not installed here" rather than
  being dropped.
- **Code never syncs.** A device that sees a synced entry it lacks fetches
  the package from `source.url`, verifies `integrity`, and caches it in a
  local, non-replicated store (a `cacheStore` sibling). Mismatch means
  "installed elsewhere, unavailable here" and no execution. `file` and `dev`
  installs are per device by nature.
- **Install paths**: paste a manifest URL in settings (the package is the
  manifest's directory), import a file (extensions and Electron), and, in
  unpackaged Electron builds only, an `ONCE_ADDONS` directory list for
  development, mirroring `ONCE_ELECTRON_EXTENSIONS`. Updates are manual
  ("Check for updates" per add-on) in the first version; the integrity hash
  changes with the version.
- **A curated index** Once ships is a later product decision; nothing here
  depends on it.

## Security model

- **No add-on code in the Once document.** Sandboxed frames on opaque
  origins with their own CSP; declarative contributions render from
  validated JSON.
- **Least data**: the story view allowlist; collectors see the body they
  asked for and nothing else.
- **Least authority**: every host operation is scoped to the current
  invocation's story, `fetch` needs a declared pattern, URLs are `http(s)`
  only, mutations go through `persistStoryChange`.
- **Bounded**: timeouts, budgets, size caps on code, manifests, icons,
  labels, storage, fetch responses, story counts.
- **Reviewable**: capabilities are shown at install and in settings; an
  add-on with no `fetch:` capability provably makes no network requests.
- **Integrity**: hash-pinned packages; a synced entry never executes code
  the local device did not verify.
- **Trust zones**: ARCHITECTURE.md gains the fifth zone and the sentence
  "add-ons are messaging peers of the UI, never residents of it".

## Boundaries

- `core`: protocol types, manifest validation, JSON-schema subset,
  condition language, template rendering, story projection, story result
  validation. DOM-free; the boundaries check enforces it.
- `collectors`: the composable registry and the `StoryParser` wrapper type;
  no knowledge of sandboxes.
- `app`: `AddonHost` (registry, broker, lifecycle, budgets), the `addons`
  document, the wrapper that turns protocol calls into `StoryParser`s, the
  package cache. Depends on a new `AddonSandboxPort` in `OncePlatformPorts`:
  `createSandbox(addonId): {post, onMessage, destroy}`.
- `ui-web`: the sandbox iframe implementation of that port (shared by all
  targets, differing only in the page URL), contribution rendering, the
  Add-ons settings section, the source-editor schema fields.
- `platform-*` / apps: serve the sandbox page (manifest `sandbox` entry,
  `once-addon://`, Capacitor route) and supply its URL.

The structure limits apply; the broker, the registry, and the renderers are
separate files from the start.

## Steps

Each step ships on its own and is covered by unit tests in
`tests/unit/{core,collectors,electron}` plus the Electron and Firefox e2e
suites where a sandbox is involved.

1. **Registries become open.** Presenter list → contribution registry keyed
   by id; `StoryMenuActionId` and `SwipeActionId` open with descriptor
   registries and labels; `storyMenuBackground` mirrors descriptors;
   `get_active()` composes built-ins with a mutable add-on list; the outline
   button becomes the first built-in contribution. No user-visible change.
2. **Protocol in core.** Types, manifest validator, schema subset, condition
   evaluator, template renderer, projections, result validation. Pure
   functions with exhaustive tests.
3. **Declarative add-ons.** The `addons` document, tolerant reader, an
   Add-ons settings section (paste manifest URL, enable, remove, errors),
   rows rendering elements and actions, native menus and the Firefox mirror
   showing them, swipe lab and keybinding editor listing them. E2E: a
   declarative "search this on X" add-on across the row, menu, swipe, and
   key surfaces. A feature by itself.
4. **Sandbox runtime and host.** `addon-sandbox.html` + runtime, the
   `postMessage` broker, timeouts, budgets, crash recovery; Electron serving
   over `once-addon://` and the extensions' manifest `sandbox` pages;
   `story.invoke` and computed badges. Fixture add-on with a computed badge
   and a `message` action in the Electron and Firefox e2e suites.
5. **Collector add-ons.** The wrapper `StoryParser`, body hand-off, result
   validation, config schema rendering in the source editor, search
   providers. Fixture: a JSON API collector for the harness page server,
   loaded as a source, searched, cached, error-surfaced. Registry-id test
   extended for namespacing.
6. **Mobile serving.** The Capacitor route on Android and iOS; the mobile e2e
   scenario runs the same fixture add-on and collector.
7. **Package cache and integrity.** Fetch-by-URL install, sha256 pinning,
   the local package store, "installed elsewhere" state, manual update
   check, `ONCE_ADDONS` for development.
8. **Capabilities.** `fetch:` patterns through the platform port with caps,
   `storage` namespace, panel actions, add-on settings controls.
9. **Documentation.** ARCHITECTURE.md trust zones and ports, CODEMAP.md
   ownership, COLLECTORS.md section on add-on collectors, an `ADDONS.md`
   for authors with the manifest reference and the two fixtures as worked
   examples.

## Open questions

- **Mutation outside an invocation.** An add-on that tags "paywalled" stories
  as they arrive needs `addTag` without a user gesture. The plan says no
  until a concrete add-on asks; the `story.badges` batch is the compromise
  that covers most of it visually.
- **Sandbox placement on Electron.** Frames in the renderer, or a hidden
  `WebContentsView` per add-on for process isolation? Frames are enough for
  capability-less code and keep parity with the other targets; revisit if
  add-ons gain heavier capabilities.
- **Collector detection by pattern.** Allowed after built-ins, or explicit
  naming only? The plan allows it; explicit-only is the conservative fallback.
- **Budgets.** Concrete numbers for parse time, badge batches, storage size,
  and fetch caps are set in step 4 from the fixture measurements.
- **Curated index and updates.** Manual first; whether Once hosts an index
  and checks updates on a schedule is a product decision.
