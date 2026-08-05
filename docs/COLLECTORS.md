# Collectors

Collectors turn a configured story source into `Story` objects. The collector
package owns source matching, response decoding, source-specific parsing, and
the registry of available collectors. Application code is responsible for
fetching, caching, grouping, filtering, and persisting the resulting stories.

The line-based source format described below, including the `§§` embedded-config
form, is scheduled to be replaced by typed source objects — see
[story-source-model-plan.md](story-source-model-plan.md).

## How a source is loaded

Each non-empty line in the Sources setting is either a source or a group
heading. A heading starts with `*`; subsequent sources belong to that group.

```text
*tech
https://news.ycombinator.com/
https://lobste.rs/
*security
https://old.reddit.com/r/netsec/.rss
```

For every source, Once:

1. finds the first registered collector whose `options.pattern` matches the
   source line;
2. calls the collector's optional `resolve_url` function to obtain the URL to
   fetch;
3. fetches or reads a cached response;
4. decodes the response according to `options.collects` (`dom`, `json`, or
   `xml`); and
5. calls `parse(input, resolvedUrl, originalSource)`.

The original source is deliberately retained. Configurable collectors such as
Geny Match store their parsing configuration in that value while fetching a
normal HTTP or HTTPS URL.

Collector order in `packages/collectors/src/registry.ts` matters because the
first match wins. Pattern matching supports exact prefixes and one `*`
wildcard. A pattern without a wildcard is a prefix, not a strict equality
check.

## Built-in collectors

| Collector | Source pattern | Input | Story type | Search support |
| --- | --- | --- | --- | --- |
| Geny Match | `geny:*` | HTML DOM | `GY` | none |
| Hacker News | `https://news.ycombinator.com/` | HTML DOM | `HN` | global and domain |
| JSON Select | `json:*` | JSON | `JX` | none |
| Lobsters | `https://lobste.rs/` | HTML DOM | `LO` | global and domain |
| Reddit JSON | `https://old.reddit.com/*.json` | JSON | `re` | global and domain |
| Reddit RSS | `https://old.reddit.com/*.rss` | DOM | `re` | none |
| Nitter | `https://nitter.net/` | HTML DOM | `tw` | none |
| RSS/Atom | `*.rss` | XML DOM | `RSS` | none |

Source-specific settings, colors, and descriptions live in each module's
exported `options` object under `packages/collectors/src/collectors`.

The dedicated HTML collectors understand the markup of Hacker News, Lobsters,
and Nitter and add source-specific user or category tags. The Reddit JSON
collector discards posts below `min_points` during normal collection. The RSS
collector supports RSS 1.0, RSS 2.0, and Atom, applies `time_cut_off`, and can
discard entries without timestamps. Reddit's Atom-shaped `.rss` response has
its own collector and is registered before the general `*.rss` pattern.

JSON Select is the JSON counterpart to Geny Match. Its source line uses the
same three-part idea with a `json:` prefix, but selectors address object keys
instead of CSS selectors. It currently exposes `parse` and `resolve_url`
directly; unlike Geny Match, it has no public builder and sanitizer entry point.

### Collector output

Every returned item must be a `Story`. `type`, `href`, and `title` must be
non-empty strings, and `timestamp` must be a finite number, valid date string,
or valid `Date`. A collector can additionally set `comment_url`, `filter`, and
`tags`. Application code adds the source-group tag, applies user filters, and
merges an already-known URL into the stored story rather than creating a
duplicate.

## Geny Match

Geny Match is the configurable HTML collector. It is useful when a site
renders repeated story cards in its fetched HTML but does not have a dedicated
collector or usable feed.

### Prefer the Source Picker

The Source Picker is the normal way to create a Geny source. Open the page in
Once's browser, start the picker from the Sources settings, and select or enter
selectors for the repeated story element, link, title, timestamp, and optional
tag. The picker previews parsed stories and saves the generated source line.

The collector parses the response body returned by the server. Content that
only appears after page JavaScript runs will not be present during ordinary
collection, even if it was visible when configuring the page in the picker.

### Source format

A Geny source contains three parts separated by `options.separator`:

```text
geny:<separator><selector JSON><separator><page URL>
```

Do not assemble this string in application code. Import the supported Geny
entry point and use `build_source`, which validates the configuration, accepts
only HTTP(S) page URLs, and rejects separator collisions.

```ts
import { build_source, type GenySelectorConf } from "@once/collectors/geny"

const conf: GenySelectorConf = {
  stories: { sel: "article.story", all: true },
  link: { sel: "a.title", component: "href" },
  title: {
    sel: "a.title",
    component: "innerText",
    processors: ["trim"]
  },
  timestamp: { sel: "time", component: "dateTime" },
  comment_href: { sel: "a.comments", component: "href" },
  tags: [
    {
      elements: {
        text: { sel: ".tag", component: "innerText" }
      }
    }
  ]
}

const source = build_source(conf, "https://example.com/news")
```

`resolve_url(source)` performs the inverse operation needed by the loader: it
returns the page URL from a Geny source line.

### Configuration shape

The top-level configuration supports these fields:

| Field | Required | Meaning |
| --- | --- | --- |
| `stories` | yes | Selects the repeated story containers. Set `all: true`. |
| `link` | yes | Selects the story URL relative to each story container. |
| `title` | yes | Selects the story title relative to each story container. |
| `timestamp` | no | Selects a value accepted by `Date.parse`; defaults to collection time when omitted. |
| `comment_href` | no | Selects the discussion or comments URL. |
| `tags` | no | Adds one or more tag mappings to each story. |

Every normal selector supports:

| Field | Meaning |
| --- | --- |
| `sel` | A CSS selector evaluated with `querySelectorAll` inside the parent element. |
| `all` | Return all matches instead of the first. Use this for `stories` and repeated tag groups. |
| `component` | Read a DOM property from the selected result, commonly `href`, `innerText`, or `dateTime`. |
| `fallback` | Use this string when selection or component lookup produces no value. |
| `processors` | Apply allowlisted string transformations in order. |

Without `component`, selection produces an element rather than its text. Link
and title selectors must ultimately produce non-empty strings for every story;
otherwise parsing fails. Relative `href` properties resolve against the fetched
page because the parser installs a base URL in the document.

The available processors are:

- `trim`: removes leading and trailing whitespace;
- `show_path`: prefixes the value with `[{url.path}] `. When used for a title,
  the placeholder is replaced with the story URL's path after the story is
  constructed.

### Tags

Each entry in `tags` can select one tag or a repeated group:

```ts
tags: [
  {
    group_el: { sel: ".tags .tag", all: true },
    elements: {
      class: { fallback: "category" },
      text: {
        sel: ".label",
        component: "innerText",
        processors: ["trim"]
      },
      href: { sel: "a", component: "href" }
    }
  }
]
```

When `group_el` is present, each matched element becomes the parent for the
selectors in `elements`. A tag requires `elements.text`; `class` defaults to
`category`. Any additional element name, such as `href` or `icon`, is copied to
the resulting `StoryTag`. A tag whose text is empty is skipped.

### Validation and failure behavior

Configurations originating in a page are untrusted. Call
`sanitize_selector_conf` before accepting them; `build_source` does this
automatically. Validation:

- permits only documented configuration, tag, and selector fields;
- permits only known processors;
- limits selector, component, and fallback strings to 500 characters;
- limits the configuration to 10 tag selectors and 20 elements per tag; and
- requires `stories`, `link`, and `title`.

The collector returns an empty array for a source that is not a complete Geny
source line. It throws a descriptive error for malformed JSON, missing required
configuration, unknown processors, invalid selectors, or empty required story
values. The application surfaces these as source parsing errors.

## Developing collectors

A collector module exports `options` plus at least `parse`. It may also export
`resolve_url`, `global_search`, or `domain_search`. Add the module to
`get_active()` in `packages/collectors/src/registry.ts`, taking overlap and
first-match ordering into account.

Keep parsing deterministic and avoid network requests inside `parse`. Search
functions are the exception: they are explicitly asynchronous providers.
Collectors should skip structurally incomplete individual entries where that
is normal for the source and throw actionable errors when the response or
configuration is unsupported.

Relevant checks are:

```bash
# Build packages, then run parser and collector fixtures
npm run test:collectors

# Manually probe the allowlisted live sources
npm run test:live:collectors

# Refresh one reviewed live fixture
npm run refresh:fixtures:collectors -- reddit_json
```

Deterministic tests and fixtures live under `tests/unit/collectors` and
`tests/fixtures/collectors`. Live compatibility cases live under
`tests/live/collectors` and are intentionally excluded from normal test runs.
