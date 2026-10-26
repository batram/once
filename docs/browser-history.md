# Browser history

The iOS, Android (Gecko and Lite), and Electron browser menus open History.
Mobile offers History only in the browser menu; it does not add a bottom-navigation
entry. Visit times use the local timezone and a 24-hour clock.
Mobile uses a shell page so it can hide the native browsing surface through the
existing panel lifecycle. Electron uses a regular, reusable browser tab under
`once-history://view/index.html` with a dedicated preload and checked IPC.

History is local to the device/profile. It is separate from story read state,
tab back/forward stacks, closed-tab restoration, and tab sync. There is no
migration from those sources because they are not a log of completed visits.
Recording begins with this implementation.

## Recording and deletion

Completed HTTP(S) pages, including background tabs and reader sources, create
visits. Redirects record the final page, not provisional destinations. URL
fragments, URL credentials, internal pages, and failed native loads are excluded.
A normal reload creates another visit; a mobile session restoration reload does
not. Title updates modify the existing visit and cannot recreate a deleted row.
Fragment-only navigation and switching an existing page into reader mode do not
create duplicate visits.

Removing a row removes that individual visit, preserving other visits to the same
address. Delete all requires confirmation and clears the entire local history,
even when a search is active. It drops and recreates the FTS index in the same
transaction rather than producing an FTS deletion record for every visit. Writes
and deletions are ordered so already queued visits cannot reappear after clear.
New navigations after clear continue recording normally.

## Storage and query costs

Installed mobile apps own a dedicated `browser-history.sqlite` outside WebView
storage. iOS uses Application Support and excludes the database from backup;
Android uses its no-backup directory and the already bundled SQLite driver.
Both bridges serialize SQL on background queues. Electron uses the profile's
`browser-history.sqlite` through a Node SQLite worker thread; a worker that
crashes is replaced on the next request after a 30-second pause. The mobile web
preview alone uses an IndexedDB adapter.

The SQLite implementation is shared in `SqlBrowserHistory`:

- `seq INTEGER PRIMARY KEY` aliases the rowid so the FTS index keys on a value
  that survives VACUUM; a database from before `seq` existed is moved over on
  open. An index on `(visitedAt DESC, id DESC)` supports chronological browsing
  and cursor pagination, including identical timestamps, without OFFSET scans.
- FTS5's trigram tokenizer indexes literal title/URL substrings of at least three
  Unicode characters. Quotes and punctuation are escaped as literal search text.
- One- and two-character queries scan normalized text in SQLite. These searches
  remain off the UI thread but their cost grows with the stored history.
- Each query returns at most 100 rows; the UI requests 50 plus a lookahead and
  keeps only the current page mounted. Newer/Older controls appear only when a
  page exists in that direction, and a later page emptied by deletions falls back
  to the one before it. Search is debounced, and outdated async results are
  ignored.
- WAL, full synchronous commits, and SQLite secure deletion are enabled in native
  stores. Delete operations checkpoint the WAL. This is application deletion, not
  a guarantee of forensic erasure from filesystem snapshots or flash storage.

The IndexedDB preview preserves the same visible paging/search behavior but
scans indexed chronological cursors for searches; its performance is not the
native implementation's performance.

## Open-source cross-check

[Chromium's history backend](https://chromium.googlesource.com/chromium/src/+/master/components/history/core/browser/history_backend.cc)
separates visit storage and history queries from a tab's navigation controller,
uses bounded query results, and has distinct chronological/text query paths.
[Firefox Places](https://firefox-source-docs.mozilla.org/browser/places/architecture-overview.html)
also uses a SQLite-backed history service. These support using an application
history database rather than retaining every tab's navigation state or scanning
synced story documents.

[SQLite's FTS5 documentation](https://www.sqlite.org/fts5.html#the_trigram_tokenizer)
describes trigram substring indexing and the limitation for searches shorter than
three Unicode characters. Once uses the index for longer literal searches and an
explicit scan for shorter ones. It does not copy Chromium's ranking, retention,
full-page content indexing, or history sync behavior.

## Reproduction and validation

After building packages, run:

```sh
node scripts/benchmark-browser-history.js 100000
node --test tests/unit/persistence/browser-history.test.js
npm exec -- playwright test --config tests/e2e/mobile/playwright.config.js browser-history.spec.js
npm exec -- playwright test --config tests/e2e/electron/playwright.config.js browser-history.spec.js
```

The benchmark uses synthetic data and in-memory Node SQLite, reports median and
p95 of 30 queries, and verifies bounded result sizes. It isolates query cost; it
is not an end-to-end phone benchmark or a disk durability measurement. On the
implementation host, 100,000 visits gave roughly 0.03 ms for recent/deep pages,
0.10 ms for rare searches, 35.84 ms for broad searches, and 16.22 ms for
absent two-character searches. The corresponding p95 figures were 0.10, 0.04,
0.12, 37.97, and 16.54 ms. Re-run the script for current measurements.

Tests cover literal and Unicode search, equal-time cursors, title updates,
individual deletion, ordered clear, repository reopening, menu integration,
background visits, restart restoration, both themes, narrow screens, paging,
and clearing with an active filter. Android's Gecko/Lite Java compilation and an
iOS simulator build validate native integration at compile time. A runtime SQL
smoke test on the iOS simulator (SQLite 3.51.0) also passed schema creation,
trigram search, Unicode short search, title updates, and clear. Device UI runtime
and device-scale performance still require native acceptance testing.
