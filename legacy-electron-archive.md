# Legacy Electron archive

The pre-monorepo Electron repository was removed after the migration audit. Its
last imported snapshot remains recoverable from Git commit
`9b7942857b39c8d2b06a6ba4d6db59a4e8b4d515` under `legacy/once-electron/` (the
import records upstream commit `04d627eba21305cd46d72bebf21e124087b58748`).
This note preserves useful design and operational information that should not
remain as executable legacy code.

## What moved into the monorepo

- Story models, filtering, redirects, source grouping, collectors, search,
  settings, persistence, and synchronization moved into the shared packages.
- Shared HTML, styles, images, icons, icon licenses, and retained presenter
  resources moved to `packages/ui-web`.
- The old privileged `BrowserView`/`webview` tab system was replaced by
  sandboxed, main-process-owned `WebContentsView` tabs in `apps/electron`.
  Navigation, compact tabs, middle-click close, reordering, URL drops,
  detachable tabs/windows, mute state, hover status, fullscreen, mouse history,
  unload confirmation, redirects, and native context menus are implemented.
- Electron Forge, Squirrel.Windows/ZIP packaging, security fuses, unit tests,
  and packaged Playwright tests replace Electron Packager and legacy editor
  tasks. Current commands are documented in `DEVELOPMENT.md`.

## Reader/outline migration

Reader mode now implements a substantial, secure replacement for the legacy
outline presenter. Shared code uses Mozilla Readability to extract articles,
rejects documents without useful readable content, resolves relative links and
media, removes active or unsafe markup and URL schemes, and renders themed
reader documents with title, byline, site name, and an original-page link.

Story buttons support current-tab and middle-click/new-tab reader opening.
Electron fetches through its validated bridge and serves generated documents
from its isolated `once-reader://` protocol; the reader button toggles back to
the original URL. Chrome and Firefox open the source in a tab and transform it
through extension scripting. Reader documents also provide cross-tab
coordinated text-to-speech controls with voice and persisted speed selection.

The legacy outline implementation additionally retried failed retrieval through
the Internet Archive, normalized archived YouTube iframe URLs, cached generated
documents behind an `outline://` protocol, and used a retained Spectral
font/style. Archive/cache fallback and exact visual parity have not been carried
forward. They are optional reader follow-up work, not reasons to retain the
unsafe legacy application.

The legacy video presenter recognized direct media, Reddit DASH and YouTube
URLs; it could fall back to `youtube-dl`, create Video.js player metadata,
quality levels and thumbnail VTT data, and included YouTube ad-skip support.
Its resources and adapted prototype remain under `packages/ui-web`, but a
working secure video presenter is still a separate milestone.

## Historical runtime and storage

The legacy app used Electron 16 with Node integration, disabled context
isolation and web security, and enabled `<webview>`, allowing remote content to
interact with privileged preloads. Those are historical implementation details,
not compatibility requirements.

It stored a native PouchDB database at `<userData>/.once_db`, a plaintext sync
URL at `<userData>/.nosync/sync_url`, and cookies in a persistent `moep`
partition. Development used the application/user-data name `once_dev`. The new
desktop target deliberately starts with v2 storage, does not import that native
database or plaintext credential, encrypts desktop sync settings, and retains
normal persistent browser cookies.

Session restoration was not complete in the legacy app. Full window/tab,
navigation, scroll-position, and recently-closed-tab restoration remains a new
milestone rather than a missing migration artifact.

## Historical product and build metadata

The legacy README described a merged story reader for RSS, Hacker News,
Lobsters, and Reddit with read/skip state, local and source search, CouchDB
sync, keyword filtering, themes, and extracted text/image/video presentation.
These capabilities are represented by current packages or the presenter work
described above.

The old build used TypeScript 4.1, Electron 16, Electron Packager, PouchDB 7,
`cross-fetch`, and vendored browser copies of PouchDB and Readability. The
workspace now owns current dependencies and build tooling, so those copies and
version pins do not need to survive.

To inspect an exact deleted file without restoring the directory, use:

```bash
git show 9b7942857b39c8d2b06a6ba4d6db59a4e8b4d515:legacy/once-electron/<path>
```
