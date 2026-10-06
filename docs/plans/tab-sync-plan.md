# Tab sync across devices — design plan (rev 6)

> Status: draft for review (rev 6, revised after five review rounds; see "Review changes" at the end).

## Context

Once runs as an Electron app, iOS and Android apps (Capacitor) and Firefox and Chrome side-panel
extensions. Each keeps its own open tabs, and none of that state leaves the device:

- Electron: `open-tabs.json`.
- Mobile: localStorage under `once:mobile-reading-tabs:v1`.
- Extensions: the browser's own tabs.

**Goal:** every Once instance can publish its open tabs to the existing CouchDB sync. A tab record
carries timestamps, a small screenshot and extensible special state, such as the video position
(YouTube in particular) and the reader scroll position. Other instances browse these tabs grouped by
device and window, and can open or continue them.

The goal also includes:

- A single **Sync** settings section holding:
  - the connection
  - the device name
  - the tab-sync options
  - encrypted add-on sync, moved from the add-ons section
  - QR pairing to a phone, which can optionally carry the add-on sync passphrase
- Two v1 extras: **send tab to device** and the **continue banner**.

### Decisions taken (user Q&A)

| Topic | Decision |
|---|---|
| Storage | Plaintext docs in the **same** CouchDB database. No extra encryption in v1. |
| QR payload | Sync URL, optionally with the **add-on sync (vault) passphrase**. A warning comes first; the passphrase is opt-in. |
| Extension scope | All tabs of normal (non-private) windows, grouped by window. |
| v1 extras | Send tab to device, continue banner. |
| Special state | An extensible provider registry from day one. v1 has `media` and `reader.scroll`. |

## Relevant existing code (verified)

### Sync

- `packages/persistence/src/PouchSyncService.ts`
  - `syncFrom` at :154.
  - Staged initial pull at :240 (settings ids at :58, then stories), then a live, unfiltered `db.sync`
    at :391.
  - **`notifyRemoteChanges` at :450 drops every doc whose id is not `sto_`.**
- `packages/persistence/src/PouchMaintenanceService.ts`: conflict cleanup at :102. It runs once after
  the initial pull and **before** live sync.
- `pouchOptions.ts`: `revs_limit: 20`, `auto_compaction`.
- `packages/app/src/AppRuntime.ts`
  - Remote changes are handled at :136–157, and only stories reach the reconciler.
  - The **local DB observer** at :158–178 sends `addon_vault` to add-ons, every other non-`sto_` doc to
    `settings.handleObservedChange`, and `sto_` docs to the reconciler.
    This is the path other windows and panels on the same DB use.
  - `client.setSyncUrl` at :223 **rejects a different destination while the vault is enabled**. It does
    this through `once:addon-vault-destination`, comparing origin and path only.
  - `AppSettings.setSyncUrl` at :217 otherwise switches the remote while keeping the same local PouchDB,
    so local docs would be uploaded to the new database.
- Sync URL storage:
  - Electron: `SecureSettings`.
  - Mobile: the native SecureSettings plugin.
  - Extensions: `browser.storage.sync` (`WebExtSyncStorage.ts`). It follows the browser profile across
    machines.

### Settings UI

- `packages/ui-web/public/shell.html`: the sync block is at :318–356.
- `settingsSectionDefinitions.js:9` registers `["sync","CouchDB Sync","#couch_input"]`.
- Other relevant files: `SettingsPanel.ts` (:180–240), `SettingsPersistence.ts`, `settingsSummaries.ts`,
  `settingsSubscriptions.ts`.
- Add-on sync:
  - Controls: `addonVaultControls.ts`, with a device-name field at :91, mounted from
    `addonInstallControls.ts:138`.
  - Logic: `AddonSync.ts` and `AddonVault.ts`. The device name lives in the vault pin; its default is set
    at :68 and :110.

### Tabs

- Shared code only has `ActiveTabPort` (`packages/app/src/types.ts:343`).
- Electron:
  - `browser/BrowserState.ts` (`TabEntry`, `WindowEntry`).
  - `browser/TabOwnership.ts` (`getAll` at :63, `activate` at :89, `notify` at :202).
  - `browser/TabEvents.ts` (did-navigate at :73, title at :307).
  - `TabManager.ts` `BrowserCoordinator` (`createTab` at :188, `openUrl` at :243, `createWindow` at :131).
  - `capturePage` in `TabHoverCard.ts:91`.
  - The reader runs in its own view (`readerRuntime.ts`, `ReaderProtocol.ts`), **not** through
    `ReaderDocumentHost`.
- Mobile:
  - `apps/mobile/src/readingTabs.ts`, with `readerScroll` stored in pixels.
  - `readingTabRuntime.ts`: preview capture at :118, reader-scroll channel at :49 and :160.
  - `readingController.ts:156` opens tabs.
  - **`InAppBrowserSurface.evaluateJavaScript` already exists** (`packages/platform-mobile/src/InAppBrowserSurface.ts:235`,
    with iOS and Android implementations).
  - The mobile reader is a sandboxed iframe behind `ReaderDocumentHost`, using the `once-reader-scroll`
    postMessage channel. Native page scripts can't see into it.
- Extensions:
  - Manifests grant `tabs`, `webNavigation`, `scripting` and `<all_urls>`.
  - `webextPorts.ts` tracks the active tab.
  - `storyNavigationBackground.ts` keeps per-tab entries in `storage.session`.

### Absent today

QR code generation and scanning, camera permissions, a `once://` scheme, a general device id, favicons,
and leader election between windows or panels.

## Architecture

```
platform TabSourcePort (electron | mobile | webext) + ReaderStateHost
        │ snapshot / activation events / runInPage / open
        ▼
packages/app  TabSyncService ─ DeviceIdentity ─ TabStateCache ─ TabStateRegistry ─ PublishQueue
        │ dev_/tth_/tsend_/tret_ docs            ▲ remote + local-observer change routing
        ▼                                        │
packages/persistence  PouchTabStore  (same DB; PouchSyncService forwards tab-doc prefixes)
packages/ui-web  RemoteTabsView · Sync section · ContinueBanner · Send-to-device · QR dialog
```

### 1. Device identity — `packages/app/src/DeviceIdentity.ts`

- `deviceId` is a random 128-bit hex value in **device-local** storage:
  - Electron: userData settings.
  - Mobile: SecureSettings.
  - Extensions: **`storage.local`, never `storage.sync`**.
- Get-or-create runs under a Web Lock (`navigator.locks.request("once-device-identity")`). Simultaneous
  window or panel startups then can't mint two ids.
- `deviceName` defaults to a platform label ("Firefox on macOS", "iPhone", …) and the user can edit it.
  - The vault's `deviceName` is adopted on first run.
  - `AddonVault.deviceName()` then reads from `DeviceIdentity`.
- `epoch` is an integer, starting at 1, stored with the id (see §3 retirement).
- **Full-profile clones are not detected in v1.** Every profile-local value is copied with the profile,
  and no other source survives restarts on all platforms. Instead, Sync › This device offers
  **"Reset device identity"**, which mints a new id and epoch 1 and retires the old id (§3). The docs
  explain when to use it.

### 2. Data model — `packages/core/src/tabsync/`

All tab docs use prefixes that `PouchSyncService` and `AppRuntime` route explicitly (§8).

**Device doc, `dev_<deviceId>`.** Only its owner writes it (others may delete it on Forget, §3).

```ts
interface DeviceDoc {
  type: "device"; schema: 1
  deviceId: string; epoch: number
  seq: number                     // owner-issued publication sequence, strictly increasing per epoch
  name: string; platform: "electron" | "ios" | "android" | "firefox" | "chrome"; appVersion: string
  sharing: boolean                // false ⇒ presence-only doc (send target), windows = []
  updatedAt: string               // owner clock at publish (display/heuristics only, never ordering)
  windows: SyncedWindow[]         // mobile: exactly one
}
interface SyncedWindow { id: string; focused: boolean; tabs: SyncedTab[] }
interface SyncedTab {
  id: string; navSeq: number       // local tab id + navigation generation
  url: string; title: string; mode: "web" | "reader"
  active: boolean; pinned?: boolean; audible?: boolean
  openedAt: string                 // tab created
  navigatedAt: string              // last committed navigation
  selectedAt: string               // last became the selected tab
  activityAt: string               // last user/media activity (scroll, playing, input) — §5
  storyId?: string
  thumb?: { id: string; w: number; h: number }
  state?: Record<string, StateEntry>
}
interface StateEntry { v: number; capturedAt: string; data: unknown }
```

**Thumbnail doc, `tth_<deviceId>_<sha1>`.**

- Immutable, with one `thumb.jpg` attachment: 320 px wide, quality 0.6, about 10–20 KB.
- Content-addressed, so it replicates once.
- The owner deletes unreferenced thumbnails after a 1-hour grace period.

**Send doc, `tsend_<targetDeviceId>_<uuid>`.**

- Fields: `{ from, fromName, url, title, mode, state?, createdAt }`.
- Written once.
- Deletion:
  - The target deletes it on open or dismiss.
  - **Any device with tab sync** deletes sends older than the shared send retention (default 14 days,
    see "Timing settings"), and sends whose target is retired. Duplicate deletions only produce
    tombstones.
  - This makes the retention a real bound even when a target never returns.

**Retirement record, `tret_<deviceId>`.**

- Fields: `{ deviceId, retiredEpoch, retiredAt, retiredBy }`. It is kept permanently because it is tiny.
- If two writes conflict, the record with the highest `retiredEpoch` wins.

**Device-local options** are never synced; they are stored next to the identity:

| Option | Default | Effect |
|---|---|---|
| Share this device's open tabs | **off** (opt-in; offered once after sync connects) | publishes windows/tabs |
| Include screenshots | on (when sharing) | `tth_` docs |
| Excluded domains | empty | tabs on these domains (and subdomains) are never published |
| Appear as a send target | on while sync is connected | presence-only `dev_` doc when sharing is off |
| Continue banner | on | §6 |
| Continue: recent-activity window | 15 min | §6 tab activity rule |
| Continue: snapshot freshness window | 30 min | §6 snapshot freshness rule |
| Stale device after | 30 days | device list shows it as stale; never deletes anything |

Viewing remote tabs never requires sharing.

**Timing settings.** Every time limit can be changed by the user, and the values above are the
defaults. The settings UI offers a short list of choices per limit (for example 5/15/30/60 min) rather
than free text, and has a "Reset to defaults" button. Banner and display windows are device-local,
because each device decides what it shows.

The **send retention** (default 14 days, choices 1/7/14/30/90 days) is the exception: it is a **synced**
setting. Any device may delete expired sends, so devices with different values would effectively apply
the shortest one. It is stored in a new settings doc `tabsync` (`{_id: "tabsync", list: {sendRetentionDays}}`)
through `PouchListStore`. The id is added to `SETTINGS_DOCUMENT_IDS` (`PouchSyncService.ts:58`) so it
arrives in the settings stage, and it is routed through the existing `AppSettings` change dispatch
(:370–415). Garbage collection applies the setting when it runs; changing it never deletes anything
retroactively without that GC pass.

### 3. Lifecycle: disable, forget, retire

**Local disable** (sharing off or presence off), within the publisher:

1. Increment the local `publishGeneration` and cancel the debounce timer.
2. Every pending capture, thumbnail encode and publish checks the generation before writing. Stale work
   is dropped.
3. All writes go through one serial `PublishQueue`, so the disable step queues *after* any in-flight write:
   - If sharing is off but presence is on, publish `{sharing:false, windows:[]}` and delete own `tth_` docs.
   - If both are off, also delete `dev_`.
4. Non-publisher runtimes (other windows or panels) send a `BroadcastChannel("once-tabsync")` message.
   The publisher performs the disable. If no publisher is running, the next one to start reads the
   options and runs the cleanup before publishing anything. In the extensions the publisher is the
   background script (§4a). It listens to `storage.onChanged` on the device-local options, and that
   event also wakes it.

**Forget device** (UI action on another device) means **durable remote retirement**:

1. Write `tret_<id>` with `retiredEpoch = that device's current epoch`, then delete its `dev_`, `tth_`
   and pending `tsend_` docs.
2. **Readers** ignore any `dev_` with `epoch <= retiredEpoch`. An offline device that comes back and
   re-uploads an old or newer revision therefore stays hidden.
3. **Owner check:** the owner checks for a `tret_` doc for its id at startup, before every publish, and
   on any `tret_` change. If one exists with `retiredEpoch >= ownEpoch`, the owner:
   - stops publishing
   - deletes its own docs (as in disable)
   - switches sharing off locally
   - shows "Removed from tab sync by *X*. Turn sharing on to rejoin."
4. **Rejoining** (turning sharing on again) sets `epoch = retiredEpoch + 1`. The device is visible again
   without anyone deleting the `tret_` doc.
5. The UI wording is "Remove from tab sync (until that device turns sharing on again)". A purely local
   "Hide" is not offered in v1.

### 4. Publication, ordering and conflicts

- **Single publisher per device:**
  - Electron and mobile: a Web Lock, `once-tabsync-publisher`, is held by one window. When that runtime
    unloads, another acquires the lock. The Electron main-process snapshot covers all windows.
  - Extensions: the **background script is always the publisher**, so tabs are published whether or not
    a panel is open (§4a). Panels never publish; they only read and send option changes.
- **Cadence:**
  - Debounce 3 s, with at least 15 s between publishes.
  - A heartbeat republish every 10 min while in the foreground.
  - A best-effort flush on background or close. It is not relied on for correctness, because the
    state cache (§5) is already up to date.
- **`seq` is owner-issued and strictly increasing.** It is stored locally with the epoch, and
  `(epoch, seq)` is the only ordering used, never wall clock.
- **Continuous reconciliation of `dev_` conflicts:**
  - Conflicts can happen without cloning: with `revs_limit: 20` and about one publish per 15 s, an
    offline device that publishes more than 20 times loses shared ancestry.
  - `TabSyncService` handles every `dev_` change from both notification paths (§8), as well as its own
    publish, by getting the doc with `{conflicts: true}`.
  - It keeps the revision with the highest `(epoch, seq)`, breaking ties by rev id, and deletes the
    losing revisions.
  - Every device computes the same winner, so concurrent resolvers agree.
  - This runs during live sync, not only in the startup maintenance pass.
- The owner always writes on top of the current winning `_rev` and resolves its own conflicts first.

### 4a. Extension background publisher (publishes without the panel open)

Both extensions have non-persistent backgrounds: Chrome uses an MV3 service worker, and Firefox an MV2
event page (`"persistent": false`). PouchDB's live sync can't be kept running there, so the background
**publishes straight to CouchDB over HTTP** instead of through the local PouchDB.

- **Shared core:**
  - Doc building, filtering, `seq`/epoch handling, retirement checks and the `(epoch, seq)` conflict
    resolution live in `packages/app` behind a `TabDocWriter` interface. The core is independent of
    PouchDB.
  - There are two writers:
    - `PouchTabDocWriter` (Electron and mobile): writes to the local DB, which replication uploads.
    - `CouchHttpTabDocWriter` (`packages/persistence`, used by `packages/webext-shell`'s background):
      - It uses `fetch` against the sync URL: `GET dev_<id>?conflicts=true`, `PUT`, `DELETE ?rev=`,
        `PUT` for the `tth_` attachments, and `GET tret_<id>`.
      - The sync URL is read from `storage.sync` (`WebExtSyncStorage`), but it is never used directly:
        every operation passes through destination binding (§9) and the Firefox consent gate below.
        The background establishes the binding before its first request, even if no panel or local
        PouchDB has ever been opened.
      - Credentials are moved out of the URL into an `Authorization: Basic` header, because `fetch`
        rejects URLs that contain userinfo.
      - The `<all_urls>` host permission covers the cross-origin request.
- **Wake-ups:**
  - `tabs.onCreated/onUpdated/onActivated/onRemoved`, `windows.onFocusChanged`,
    `webNavigation.onCommitted`, `storage.onChanged` (options and `sync_url`), and `alarms`. This needs
    a new `alarms` permission in both manifests. URL changes invalidate queued network work and are
    revalidated against the device-local destination binding before another request (§9).
- **Timing under MV3 limits:**
  - The 3 s debounce runs in memory, since the worker stays alive for at least 30 s after an event.
    It falls back to a one-shot alarm.
  - Sampling is an alarm every 30 s while an audible or selected tab has a state provider. Raise
    `minimum_chrome_version` from 114 to **120**, where 30-second repeating alarms are supported.
    This is an explicit compatibility change; there is no Chrome 114–119 fallback in v1.
  - The heartbeat is an alarm every 10 min.
  - `seq`, the epoch, the last published hash, pending dirty flags and the state cache are persisted
    in `storage.session` and `storage.local`, so a restarted worker resumes without losing them.
- **State capture without the panel:**
  - `scripting.executeScript` for `page` providers.
  - Messages to open reader pages (`readerPage.ts`) for `reader` providers.
  - Outgoing-tab capture uses a per-window active-tab map (§5); Chrome's activation event has no
    `previousTabId`. Firefox's field is an optional shortcut.
  - Thumbnails via `captureVisibleTab` from the background.
- **Offline:** a failed request leaves the dirty flag set and schedules a retry alarm with backoff.
  No tab documents are written to local PouchDB; the binding and pending state remain in extension
  storage. The panel's local PouchDB receives the published docs through normal
  replication like any other device's docs, so the panel's `RemoteTabsView` shows this device's own
  doc consistently.
- **Incoming sends without the panel:**
  - On heartbeat and sampling alarms, the background polls `_all_docs` with both bounds:
    `startkey = JSON.stringify(prefix)` and `endkey = JSON.stringify(prefix + "\uffff")`, where
    `prefix = "tsend_" + ownDeviceId + "_"`, plus `include_docs=true`. Encode the query parameters
    with `URLSearchParams`; paginate within these same bounds. `_changes` long-polling is avoided
    because the worker can't hold it open.
  - Validate the exact target prefix, send schema and non-deleted document before displaying a
    notification. Revalidate the target, current identity and pending send before opening or
    acknowledging it; a notification is not authority to act on an arbitrary document ID.
  - New sends raise a browser notification (optional `notifications` permission). Clicking it opens the
    tab and deletes the send doc over HTTP.
- **Manifest and store review:**
  - Add `alarms` (both) and optional `notifications`.
  - Set Chrome's minimum version to 120 and note it in the release documentation.
  - Firefox data collection declaration: see "Firefox data collection declaration" below.

**Firefox data collection declaration**

- **Does this count as collection?** By Mozilla's wording, yes. The Extension Workshop defines data
  transmission as any data "handled outside the add-on or the local browser". Neither that page nor the
  Add-on Policies make an exception for a server the user configures. Sending tab URLs and titles,
  screenshots, and scroll or playback positions to the user's CouchDB is therefore transmission, even
  though no data reaches the developer.
- **Existing gap:** today's story sync already sends story URLs, read state and saved article text to
  the same CouchDB while declaring `required: ["none"]`. Tab sync makes the gap bigger rather than
  creating it.
- **Plan:** keep `required: ["none"]`, because the extension works fully without sync. Declare these
  categories as **optional at installation**, and request them together from a user action when
  connecting or resuming sync with `browser.permissions.request({ data_collection: [...] })`:
  - `browsingActivity`: tab URLs and titles, and story URLs and read state.
  - `websiteContent`: screenshots and saved article content.
  - `websiteActivity`: reader scroll and media playback positions.
- **v1 consent applies to the whole sync connection.** Require all three categories before any
  shared-database replication or background HTTP sync operation. The database is replicated without
  filtering and can contain previously queued data and other devices' documents, regardless of this
  device's capture toggles. Disabling screenshots or new article saving cannot prevent existing
  attachments from being uploaded. Per-category replication is out of scope for v1.
- A shared consent gate checks granted permissions before startup, resume and retries, and before
  direct HTTP requests. Existing installations with a saved URL stay disconnected until consent is
  granted. Background startup never prompts; Settings shows an action to grant consent and resume.
  On Firefox versions without the built-in consent API, sync remains disabled with an explanation
  to upgrade; local reading remains available.
- Listen for permission removal. Revocation of any category cancels all panel replication, aborts
  pending background requests, invalidates queued network work and pauses retries across contexts.
  Work already accepted by the server cannot be recalled. Keep local data and the destination binding;
  granting consent again permits a guarded restart. Recheck permissions after asynchronous startup
  work so revocation during initialization cannot start a replication afterwards.
- If a category is declined, the connection remains paused. The UI explains that the shared database
  requires all three categories and that local sharing/screenshot toggles control new capture only.
- Chrome has no manifest equivalent. The Chrome Web Store privacy disclosure gets the same categories
  and states that data goes only to the user's own server.
- This gate covers existing story sync as well as tab sync and ships in phase 1, before any new
  background publisher. See [Mozilla's consent documentation](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/).

- **Mobile and Electron** don't get a background publisher in v1. Mobile flushes on pause, and Electron
  runs while its windows are open.

### 5. State: cache, capture triggers, providers

**`TabStateCache`** (per runtime, in `packages/app`)

- Keyed by `(tabId, navSeq)`. It is updated independently of publication, and a publish reads only
  this cache.
- Entries for a previous `navSeq` are discarded on navigation.
- **Every async capture or restore result carries `(tabId, navSeq)`**. It is dropped if the tab has
  navigated or closed since.

**Capture triggers**

- Event-driven where possible:
  - Reader scroll messages, throttled to 2 s.
  - Media `pause`, `seeked`, `ended` and `ratechange` events, from a small page listener installed after
    each navigation where the platform can inject one.
- Bounded sampling: every 15 s for the selected tab while the app is in the foreground, and for audible
  tabs.
- **Outgoing tab on deactivation:**
  - Electron: the `TabOwnership.activate` previous id.
  - Extensions: maintain `activeTabByWindow` in `storage.session`, serialized with activation handling
    so it survives background-worker suspension. Seed it from the window snapshot on first startup;
    capture the saved outgoing ID before replacing it with the event's `tabId`. Chrome events contain
    only `tabId` and `windowId`; Firefox's optional `previousTabId` can supply the outgoing ID directly.
    Update the map on tab removal, attachment/detachment and window removal. If the previous tab has
    closed or the map is unavailable after browser restart, skip that capture and use the last cached
    state; do not guess an outgoing ID. See the [Chrome activation API](https://developer.chrome.com/docs/extensions/reference/api/tabs#event-onActivated).
  - Mobile: `ReadingTabs.select`.
  - This also covers a video paused and then switched away from.
- Best-effort flush on background or close.
- `activityAt` updates when a sample or event shows change: scroll moved, media playing or time advanced,
  or user input. A 45-minute video or reading session therefore stays "recently active" without any tab
  switch.

**Provider contract** (`packages/core/src/tabsync/state/`)

```ts
interface TabStateProvider<T> {
  id: string; version: number               // namespaced ids: "media", "reader.scroll", later "addon:<id>:<key>"
  host: "page" | "reader"                   // which adapter captures/restores it
  appliesTo(tab: { url: string; mode: "web" | "reader" }): boolean
  capture: HostScript<T | null>             // "page": serialisable fn for runInPage; "reader": request over ReaderStateHost
  restore?: HostScript<void, T>
  rewriteUrl?(url: string, data: T): string // pre-load restore (YouTube ?t=)
  summary?(data: T): string                 // "▶ 12:34 / 45:10", "Reader · 40 %"
}
```

**Host adapters**, part of each platform's `TabSourcePort`:

- `runInPage(tabId, script)`:
  - Electron: `webContents.executeJavaScript`.
  - Extensions: `scripting.executeScript`.
  - Mobile: the existing `InAppBrowserSurface.evaluateJavaScript`, plus result parsing.
- `ReaderStateHost` (`capture`, `restore`, `onChange`) is implemented per reader:
  - Mobile and extensions (if they use it): extend the `once-reader-scroll` channel in
    `ReaderDocumentHost` with `request`/`state` messages that carry `{fraction, anchor}`.
  - Electron reader view: `runInPage` against the reader runtime document. Verify where the Electron
    reader keeps its scroll.

**Registry behavior:** unknown provider ids or newer versions are carried along untouched and ignored on
restore. On open, the registry runs `rewriteUrl`, waits for load, then runs `restore` with retries,
bound to the new tab's `navSeq`.

**v1 providers**

- **`media`** (host `page`):
  - Captures `{currentTime, duration, paused, rate}` from the playing media element, or else the most
    recently played one, or else the longest.
  - For YouTube (`youtube.com/watch`, `m.youtube.com`, `youtu.be`, `youtube-nocookie`), `rewriteUrl` sets
    `t=<s>s`.
  - Restore seeks to the position but never autoplays.
- **`reader.scroll`** (host `reader`):
  - Captures `{fraction, anchor: {index, text: first 64 chars of first visible block}}`.
  - Restore prefers the anchor and falls back to the fraction.
  - Mobile's own pixel `readerScroll` stays for its local tabs.

### 6. Freshness, clocks and the continue banner

The banner requires all of the following:

- **Tab activity:**
  - `0 ≤ doc.updatedAt − tab.activityAt ≤ activityWindow` (default 15 min, set by the user). Both values
    come from the same clock, so skew doesn't matter.
  - The tab has a `media` or `reader.scroll` entry with `capturedAt ≥ activityAt − 1 min`.
- **Snapshot freshness (conservative v1 rule):**
  - For every delivery path—cache, initial pull, live sync and reconnect catch-up—require
    `−2 min ≤ now − doc.updatedAt ≤ freshnessWindow` (default 30 min, set by the user).
  - A new `(epoch, seq)` or a recent local `receivedAt` proves only that this receiver has received a
    publication, not when the owner made it. Live sync can deliver days-old queued publications after
    a network interruption. Receipt never renews freshness or bypasses the timestamp check.
  - Future-dated snapshots beyond the 2-minute tolerance are marked as having uncertain clock times
    and excluded from the banner. Large source-clock skew can also make current snapshots appear old;
    v1 deliberately suppresses those banners. Remote tabs remain available to open manually. There is
    no claim of skew-independent freshness without a separate clock/liveness protocol.
  - Re-evaluate eligibility as time passes, on resume and after reconnect; do not retain a previously
    eligible banner indefinitely. `receivedAt` may be stored for diagnostics only.
- The tab is not dismissed. Dismissals are stored locally by `deviceId + tabId + navSeq`.
- The device is not retired, and is not this device.

Text: "Continue *Title* from *iPhone* at 12:34". Actions: Open, Dismiss.

**Displayed ages:** label `max(0, now − updatedAt)` as an approximate snapshot age based on device
clocks, and `updatedAt − activityAt` as activity age **at that snapshot**. Never replace snapshot age
with time since receipt. For future-dated or inconsistent timestamps, show "Device time differs;
freshness unknown" instead of an apparently precise age. Cross-device ages remain approximate in v1.

### 7. UI — `packages/ui-web/src/tabsync/`

**`RemoteTabsView`**

- Lists devices (platform icon, name, freshness), each expanding into windows and then tab rows.
- Tab rows show the thumbnail, title, domain, ages and a state badge.
- Actions: open, open in background, open all (window), send to another device, copy link.
- Has a filter box and skips this device and retired devices.
- Entry points:
  - **Mobile (decided): the tab view.** An "Other devices" section in the tab switcher
    (`apps/mobile/src/readingTabDialog.ts`) sits below this device's tabs. It shows device groups with
    thumbnails in the same card style, and incoming sends are listed at the top.
  - **Side panel menu (extensions; Electron optionally):** a permanent **Tabs** entry (`#tabs_menu_btn`,
    `data-panel="tabs"`, `data-testid="tabs-menu"`) placed right after the Stories section,
    with temporary entries below it. It opens a new `#tabs_panel` in `#left_main` that hosts `RemoteTabsView`.
    The details are in "Side panel Tabs entry" below.
  - **Electron, set by the user:** a device-local setting, "Show tabs from other devices in", with the
    choices *Tab bar button* (default), *Side panel menu* and *Both*.
    - *Tab bar button:* a tab-sync button next to `#new_tab_btn` in
      `apps/electron/src/browser/browser-shell.html`. It opens the view as a **page in a tab**.
    - The page is a privileged internal scheme, `once-tabs://view`. It is registered in the one
      `registerSchemesAsPrivileged` call in `main.ts:58` and handled like `ReaderProtocol.ts`. Because
      it is a normal `WebContentsView` tab, the tab strip, closing, the reopen stack and window moves
      keep working unchanged.
    - Clicking the button again focuses the existing tabs page in that window instead of opening a
      second one.
    - The page has no database of its own. A small preload bridge relays a `RemoteTabsViewModel`
      (devices, windows, tabs, pending sends) from the window's shell renderer through the main process.
      It sends actions back the same way: open, open all, send, remove device, dismiss. The page reuses
      the shared `RemoteTabsView` DOM component and the shell styles.
    - The open page is excluded from the published tabs, because `tabFilter` drops the non-http scheme.
  - Mobile: the side panel Tabs entry is hidden (`data-platform-only`), because remote tabs live in the
    tab view.

**Side panel Tabs entry (works with add-on and comments entries)**

The menu already gets entries at runtime. `TemporaryPanel.create`
(`packages/ui-web/src/shell/temporaryPanel.ts:31`) adds a button for each add-on conversation thread
(`addons/addonPanel.ts:180`) and for each story's comments (`story/commentsPanel.ts:89`). It appends
them at the end of the menu with `menu.insertBefore(button, #status_dock)`.

- **Order:** Settings, Reading, Stories (with filters), **Tabs**, then the *temporary entries (thread,
  comments)* at the bottom, then `#status_dock`.
  - Tabs is a permanent entry in the static markup, right after the Stories section. It is not forced to
    the bottom.
  - Temporary, non-permanent entries keep going to the bottom. `TemporaryPanel.create` needs **no
    change**: inserting before `#status_dock` already places them after Tabs.
- **Static markup:** the Tabs button is a plain `button.sidebar_panel` child of `#menu` in `shell.html`,
  so `panelNavigation.init` (:86) binds it like Settings and Reading, including `active_flash_panel`.
  Open and close history then works with temporary panels. Closing a thread or comments panel returns to
  Tabs if Tabs was the previous panel, and the reverse also holds.
- **The panel stays usable while temporary panels open:** opening a thread or comments panel switches
  `active_panel` away from Tabs as usual. `RemoteTabsView` keeps its state (filter text, expanded
  devices, scroll) while hidden, and re-renders only on data changes. Docs that arrive while the panel is
  hidden are batched.
- **Visible but collapsed:** in the collapsed menu (`menuCollapse.ts`) the entry shows only its icon. A
  new `icon--tabs` chrome icon is needed; register it in the design-system icon audit. A badge shows the
  count of pending incoming sends, which matches how temporary entries flash.
- **Keyboard:** the entry joins the menu's existing focus order. No new global shortcut is added in v1.
- **Hidden state:** while sync isn't connected, the entry stays visible and the panel shows "Connect sync
  to see tabs from your other devices" with a link to Settings › Sync. On Electron it is hidden when the
  user picks *Tab bar button* only.
- **Tests (web e2e in extensions plus Electron):**
  - Open a comments panel and an add-on thread. Assert the order Stories, Tabs, Comments, Thread.
  - Switch Tabs → Comments → close, and Tabs is active again.
  - The Tabs filter text survives the switch.
  - The send badge updates while another panel is active.

**Send to device**

- Available from the tab context menus (Electron tab menu, mobile long-press, extension context menu)
  and from remote rows.
- Targets are devices whose presence doc exists and that are not retired.
- An incoming send shows a toast with Open and Later. Pending sends are listed under "Sent to this device".

**Sync settings section**

- The `settingsSectionDefinitions.js` row is renamed to "Sync". The section contains:
  1. Connection: the existing field and status.
  2. This device: name and "Reset device identity".
  3. Tabs: share, screenshots, excluded domains, send target, continue banner, and the device list with
     freshness and **Remove from tab sync**.
  4. Add-on sync: `addonVaultControls` moved here from `addonInstallControls.ts:138`. It uses the shared
     name.
  5. Pair a device: show QR or copy link, and scan or paste a link.
- Also update `settingsSummaries.ts`, `settingsSubscriptions.ts`, `docs/addon-sync-vault.md` and the
  README.
- The help text states that tab data is stored unencrypted in the sync database.

### 8. Sync plumbing (both notification paths)

- **`PouchSyncService.notifyRemoteChanges`** (:450): replace the hard `sto_` filter with prefix routing.
  - `sto_` goes to the existing handlers.
  - `dev_`, `tret_` and `tsend_` go to a new `onRemoteTabChange` port method (added in `types.ts`).
  - Deletion docs (`_deleted: true`) are forwarded too.
  - `tth_` is not routed; thumbnails are fetched on demand.
- **`AppRuntime` local observer** (:158): add a tab-prefix branch **before** the
  `settings.handleObservedChange` fallback, also covering deletions. This delivers writes and send-acks
  made by another window or panel on the same DB.
- **Initial load:** at start, `TabSyncService` reads cached `dev_`, `tret_` and `tsend_` docs with
  `allDocs` range queries, so the view renders offline and before sync.
- **Initial pull stage:** after settings, pull `dev_`, `tret_` and `tsend_` by id range (a replication
  `selector`, or `doc_ids` from a remote `allDocs` range).
- **`PouchTabStore`** (`packages/persistence`) provides:
  - publish (conflict-aware, §4)
  - list, and resolving conflicts
  - `getThumb` (attachment to object URL) and `putThumbIfMissing`
  - send, list and ack for send docs
  - retire
  - GC

### 9. Destination binding (protects QR pairing and URL edits)

Problem: `setSyncUrl` re-points the same local PouchDB, and live sync is unfiltered. Other devices' tabs
and screenshots from database A would therefore be uploaded to database B.

- Generalize the vault check in `AppRuntime` (:223) into **`SyncDestinationBinding`**:
  - It stores `once:sync-destination` (normalized origin plus path, no credentials) in device-local
    storage, shared by the device's runtimes. It is never kept in `storage.sync`.
  - Establish it **before starting replication or making the first background HTTP sync request**,
    under a shared initialization lock. Do not wait for a tab document to appear locally: the
    background publisher may never open PouchDB, and unfiltered replication may import tab documents
    immediately. Persisting the binding must succeed before any network operation is allowed.
  - This conservatively binds all v1 sync connections, including a connection currently used only for
    stories. Switching databases within one profile is no longer offered after the first connection.
    Clearing the URL, disabling sharing or revoking consent does not clear the binding.
  - On upgrade, migrate an existing vault destination first, or bind the previously configured URL
    before starting the new sync code. If existing local data has no trustworthy destination, require
    a separate profile rather than infer its source from a newly received browser-synced URL. Migration
    must not silently rebind data from a known destination to the latest value of `sync_url`.
- Every requested URL is classified, whether it comes from settings, pairing, startup or browser sync:
  - **Initial pairing**: no binding and no data requiring a known previous destination. Allowed;
    create the binding before connecting. A saved URL alone is not authorization to bypass migration.
  - **Same destination, new credentials**: same origin and path. Allowed.
  - **Different destination while bound**: rejected with "Use a separate Once profile for another sync
    database". This includes after clearing the URL, because the binding persists, matching vault
    behavior.
- **Enforcement is at the transport boundary**, not just `client.setSyncUrl`:
  - `AppSettings.startSync`/`PouchSyncService.syncFrom` must pass the gate on startup, resume and
    replacement of a replication. The same gate covers initial pull and live replication.
  - `CouchHttpTabDocWriter` and background inbox/ack/GC requests pass it before every operation,
    together with the consent gate (§4a). Background-only use creates the same durable binding as a
    panel connection.
  - Observe `storage.sync` URL changes in the background and open panels. Cancel the current transport,
    invalidate queued requests using a connection generation, and reclassify the new URL against the
    existing binding. Re-read the generation after asynchronous gate checks. Never redirect old queued
    work to a replacement URL. Same-destination credential changes may restart after validation.
  - A different destination pauses this device's sync and shows the separate-profile error. Keep the
    local binding unchanged; do not write an old URL back into browser sync and cause a cross-device
    settings loop. A restart must perform the same validation even if no change event was observed.
- PouchDB purge is adapter-specific and deletions would leave tombstones in B, so local isolation is out
  of scope for v1.

### 10. QR pairing

- **Payload**: `once://pair?v=1&u=<base64url(syncUrl)>[&p=<base64url(vaultPassphrase)>]`.
- **Generate** (Settings › Sync › Pair a device):
  - A warning comes first ("contains your sync password…", plus a stronger line if the passphrase is
    included).
  - The passphrase checkbox defaults to off.
  - The vault stores only its key, so the user types the passphrase and it is verified with
    `vaultCrypto.unlockEnvelope` before encoding.
  - The QR is blurred until clicked and auto-hides after 60 s.
  - The encoder is `qrcode-generator` (MIT, ~20 KB), rendered as SVG. It must pass knip, the boundary
    checks and the license inventory.
  - "Copy pairing link" gives the same payload as text.
- **Scan or receive** (mobile):
  - Scanner: **`@capacitor-mlkit/barcode-scanning`** (Capawesome). It scans inside the app on iOS and
    Android, and supports Capacitor 8 (check the exact version when adding it). It needs
    `NSCameraUsageDescription` and the Android `CAMERA` permission. Its Android module downloads the
    scanner through Google Play services, so check this on a device without Play services, and fall back
    to "Paste pairing link".
  - A `once://` URL scheme (iOS `CFBundleURLTypes`, an Android intent filter, `App.addListener("appUrlOpen")`).
  - A "Paste pairing link" field works on every platform.
- **Apply**:
  1. Classify the URL (§9).
  2. A different destination while bound shows the separate-profile error. Nothing is changed.
  3. A same-destination credential update or an initial pairing shows a confirm sheet:
     "Connect to `host/db` as `user`?".
  4. Call `setSyncUrl`.
  5. If a passphrase is included, wait for `onSettingsReplicated` and run
     `AddonSync.unlock(passphrase, remember=true, sharedDeviceName)`.
  6. Never persist the passphrase beyond the vault's remember option.

## Phasing (each phase shippable)

0. (done) This plan lives in `docs/plans/tab-sync-plan.md`.
1. **Foundations**:
   - Core types and `tabFilter` (schemes, userinfo stripping, excluded domains, private windows).
   - `DeviceIdentity` (with lock, vault-name migration and reset).
   - `SyncDestinationBinding`.
   - Prefix routing in both notification paths.
   - `PouchTabStore`, `TabSyncService` (publisher lock, `PublishQueue`, `seq`, conflict reconciliation,
     disable and retire) and the Sync settings consolidation.
   - Electron `TabSourcePort`.
   - Firefox optional `data_collection` categories and runtime requests, including for the existing
     story sync; shared consent gate for startup, queued data and revocation.
2. **Remote tabs UI and open**: Electron first, then the mobile tab view, then the extension background
   publisher (§4a, with `CouchHttpTabDocWriter`) and its panel view. This includes bounded inbox polling,
   the per-window active-tab map, transport guards and Chrome's minimum-version bump to 120.
3. **Thumbnails** (`tth_`, per-platform capture, GC, toggle).
4. **State**:
   - `TabStateCache`, the triggers and `navSeq` binding.
   - The registry and host adapters, including the `ReaderStateHost` changes.
   - The `media` and `reader.scroll` providers, and restore on open.
5. **Send to device**, then the **continue banner**.
6. **QR pairing**: generation, warnings and paste-link first, then mobile scanning and the `once://` link.
   This phase can run in parallel with phases 2–5 once §9 is in.

### Phase 1 status (implemented)

- Core records, filters, options and destination rules: `packages/core/src/tabsync`,
  `packages/core/src/settings/syncDestination.ts`.
- App: `DeviceIdentity`, `SyncDestinationBinding`, `SyncGate`, `TabDocRepository`, `TabSyncService`
  and the runtime wiring `SyncControls` in `packages/app/src/tabsync`. The gate runs in
  `AppSettings.startSync`, so startup, URL edits, browser-synced URL changes and consent changes all
  pass it before replication starts.
- Persistence: `PouchSyncService` routes `dev_`/`tsend_`/`tret_` changes (deletions included), pulls
  them in a stage before stories and lists `tabsync` among the settings records; `pouchTabDocs`
  adapts the local database.
- Electron publishes every window's tabs from one runtime (`TabSyncTimes.ts`, IPC
  `once:tabsync:*`). Extensions and mobile can view devices and manage options; their tab sources
  (the extension background publisher, §4a, and the mobile tab view) arrive in phase 2.
- Settings: one **Sync** section with the connection, Firefox consent, this device's name and
  identity reset, tab options with the configurable times, the device list with **Remove from tab
  sync**, and add-on sync moved from the add-ons section.
- Firefox declares the three categories as optional and requests them from Settings › Sync.
- A browser-synced URL over existing local data without a binding waits until the user presses
  **Save** for that URL, which confirms it.
- Tests: `tests/unit/core/tab-sync.test.js`, `tests/unit/persistence/tab-docs.test.js`,
  `tests/integration/app/tab-sync.test.js`, `tests/integration/app/sync-gate.test.js`,
  `tests/e2e/electron/tab-sync.spec.js`.

### Phase 2 status (implemented)

- Shared view `packages/ui-web/src/tabsync/RemoteTabsView.ts` (devices, windows, filter, open in
  front or behind, open all, folding kept across updates) over a `RemoteTabsPort`, with the client
  adapter in `tabsPanel.ts`; styles in `parts/remote-tabs.css`.
- Side panel **Tabs** entry right after Stories (temporary thread/comments entries still go to the
  bottom); on in the extensions, a choice on Electron, hidden on mobile.
- Electron: a tabs button beside "+" (default) opens `once-tabs://view/index.html` in a tab, fed by
  `RemoteTabsRelay.ts` from the window's shell (`remoteTabsHost.ts`), following the shell's theme;
  "Show other devices' tabs in" (button / side panel / both) in Settings › Sync.
- Mobile: reading tabs carry tab sync times (`readingTabs.ts`), are published through
  `readingTabSync.ts`, and the tab view lists "Other devices" below this phone's tabs.
- Extensions: the background publishes every normal window's tabs over HTTP
  (`packages/webext-shell/src/tabSyncBackground.ts`, `tabSyncTimes.ts`,
  `packages/persistence/src/CouchHttpTabDocs.ts`) with every request passing the binding and consent
  gate; a browser-synced URL change ends the connection. `alarms` permission added; Chrome minimum
  raised to 120. Panels show the sharing options because the background shares.
- Not yet: extension reader-page tabs are not published (their URL is a token; phase 4 maps them),
  and incoming-send notifications wait for phase 5.
- Tests: `tests/unit/ui-web/remote-tabs-view.test.js`, `tests/unit/persistence/tab-docs.test.js`
  (HTTP store), `tests/unit/mobile/reading-tabs.test.js`, `tests/e2e/electron/tab-sync.spec.js`,
  `tests/e2e/extensions/chrome-tab-sync.spec.js`, `tests/e2e/mobile/tab-sync.spec.js`.

## Nice-to-haves (not v1)

- Recently closed tabs from other devices.
- Closing remote tabs via command docs.
- Opening a remote window as a new window.
- Global search over remote tabs.
- Linking remote tabs to stories (read state).
- Per-tab back/forward history.
- Add-on-registered providers.
- Encrypting tab docs with the vault key.
- Push notifications for sends on mobile.
- Favicons.
- Local isolation for switching databases in one profile.
- Clone detection.
- Per-category Firefox replication consent and clock/liveness protocols for skew-independent banners.

## Decisions from review round 2

1. Remote tabs on mobile live in the tab view (§7). Electron and the extensions use the proposed entry
   points, so a reviewer may still want to adjust those.
2. Scanner: `@capacitor-mlkit/barcode-scanning` (no user preference).
3. All time limits can be set by the user, with the suggested values as defaults (§2 "Timing settings").
   Send retention is synced so that devices agree.
4. Extensions publish without the panel open, through the background publisher (§4a).

## Decisions from review round 3

1. Extensions: a permanent **Tabs** entry at the bottom of the side panel menu opens a Tabs panel.
   Temporary add-on thread and comments entries stay at the bottom, below Tabs (§7, rev 5).
2. Electron: the user chooses a tab bar button next to "+", which opens an internal tabs page, the side
   panel entry, or both. **The default is the tab bar button** (confirmed).
3. Firefox: publishing to the user's own CouchDB still counts as transmission under Mozilla's
   definition. The categories are declared as optional and requested at runtime when the feature is
   turned on (§4a).

## Open questions for reviewers

None outstanding. The Firefox declaration fix for the existing story sync ships in phase 1 together with
tab sync, because it uses the same consent mechanism.

## Decisions from review round 5 (rev 6)

1. Bind every sync connection before transport startup, including story-only and background-only use.
   Check startup and externally synchronized URL changes as well as explicit URL edits (§9).
2. Firefox requires all three declared categories for the shared sync connection. Declining or revoking
   one pauses both replication and background HTTP sync; capture toggles cannot filter queued data (§4a).
3. Use the conservative source-timestamp freshness rule for every delivery path. Significant clock skew
   can suppress the banner in v1; receiving an old publication through live sync never refreshes it (§6).
4. Track outgoing tabs per window for Chrome, and bound and validate background inbox queries (§4a/§5).
5. Raise the Chrome minimum to 120 for 30-second repeating alarms. See the
   [Chrome lifecycle version history](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle#chrome-120).

## Verification

- **Unit** (`tests/unit/core`, `tests/unit/app`):
  - `tabFilter`, including excluded domains.
  - The `(epoch, seq)` winner choice.
  - Retirement filtering.
  - Destination classification: initial, same-destination credentials, different destination.
  - Destination normalization, migration precedence and connection-generation invalidation.
  - Inbox bounds and exact target-prefix validation, including unrelated document types.
  - Provider passthrough of unknown ids and versions.
  - YouTube `rewriteUrl`.
  - Reader anchor and fraction restore.
  - Banner eligibility table: long uninterrupted session, stale snapshots from cache, initial sync and
    live reconnect catch-up, ±1 h skew, future-dated doc and expiry while displayed. Skewed or old
    publications do not become eligible merely because a new sequence was received.
  - QR payload round-trip.
  - `DeviceIdentity` concurrent init under the lock.
- **Integration** (`tests/integration/app`, `tests/helpers/fake-platform.js`, two `AppRuntime`s on memory
  PouchDBs):
  - **A → B pairing:** A is bound to DB1 with tab docs, and pairing to DB2 is rejected. Assert DB2
    contains no doc from A.
  - **Startup binding:** a bound local DB restarts with a different saved URL; no initial pull or live
    replication starts against the new destination. Exercise vault-binding migration and missing
    destination provenance without silently assigning existing data to a newly supplied URL.
  - **Connection change race:** changing the URL while validation or a retry is pending invalidates
    that work. Same-destination credential replacement can restart; a different destination cannot.
  - **Forget, offline return:** forget device X while X is offline. X publishes more and then
    reconnects; X stays hidden, then self-retires and deletes its docs. After X re-enables sharing it is
    visible again with `epoch + 1`.
  - **Disable during in-flight capture:** a pending slow capture resolves after disable, and no doc is
    written.
  - **More than 20 offline publishes, then reconnect:** exactly one winning revision with the highest
    `seq`, and no remaining conflicts.
  - **Switch tab after reading:** read in tab A, switch to B, publish. A's `reader.scroll` holds the
    final position.
  - **Pause and switch:** the paused video position is captured.
  - **Navigation race:** a late capture for the previous `navSeq` is dropped.
  - **Two runtimes on one DB:** a non-publishing panel updates after the publisher writes and after a
    send ack. Publisher lock handover works.
  - **Send retention:** a send to an abandoned target is removed by another device after the synced
    retention. Test with the default and with a changed value.
  - **Configurable windows:** changing the activity and freshness windows changes banner eligibility.
  - **Delayed live delivery:** keep live replication configured, disconnect the receiver, publish a
    snapshot on the source and stop the source. Reconnect after the freshness window. The unseen
    sequence arrives through live sync but does not show a banner or acquire a new snapshot age.
- **Electron e2e** (`npm run test:electron:e2e`):
  - Tabs in two windows are grouped in `dev_`.
  - Opening a remote tab restores `media` on a local video fixture and reader scroll.
- **Extensions** (`npm run test:extensions`):
  - Two windows are captured and an incognito window is excluded.
  - `captureVisibleTab` produces a thumbnail.
  - Chrome activation with only `{tabId, windowId}` captures the outgoing tab from the per-window map,
    including after worker suspension. Cover removal, cross-window movement and a missing map after
    browser restart; Firefox's optional `previousTabId` also works.
  - A remote tab opens.
  - **Panel closed:** with no side panel open, opening and navigating tabs publishes `dev_` to a test
    CouchDB over HTTP. A service-worker restart (Chrome) keeps `seq` increasing.
  - A failed request while offline is retried on the next alarm.
  - **Background-only binding:** publish with no panel or local PouchDB, restart the worker and attempt
    a different destination. The binding persists and no request is sent to the new database.
  - **Browser-synced URL change:** simulate `storage.sync` replacing the URL from another installation,
    both with an open panel and with the panel closed, then restart. Background requests and panel
    replication remain blocked for the different destination; the device-local binding is unchanged.
  - **Firefox consent:** upgrade with an existing URL, local saved article attachments and queued tab
    documents but without the new grants. Neither replication nor direct HTTP sync starts. Grant all
    categories, then revoke each in turn during initialization and active sync; no new requests start
    after revocation is handled. Regranting resumes through both gates. Test the unsupported-consent-API
    path and a saved URL arriving through browser sync without a user gesture.
  - **Inbox isolation:** seed sends to two devices and documents outside the inbox prefix; only this
    target's pending sends produce notifications. Clicking opens and acknowledges only its send.
    Test pagination and identity reset between notification display and click.
  - **Chrome compatibility:** assert the manifest minimum is 120 and verify 30-second alarm creation
    with packaged-extension timing semantics, including alarm setup after worker/browser restart.
- **Mobile** (`npm run test:mobile`, then `test:mobile:web` with a single spec, then iOS and Android e2e):
  - The "Other devices" section.
  - Open in reader with scroll restored.
  - Pairing-link paste.
  - QR scan, tested manually on a device.
- **Manual end to end**: all five apps on one local CouchDB. Check that YouTube continues at the right
  second, the reader continues at the right paragraph, sends and the banner work, and pairing works with
  and without the passphrase.
- `npm run check` passes.

## Review changes (round 1 → rev 2)

| Finding | Resolution |
|---|---|
| P1 QR pairing via `setSyncUrl` leaks A's docs to B | §9 destination binding with initial, same-destination and different-destination cases; v1 keeps the separate-profile rule; A→B test. |
| P1 Forget has no durable meaning; disable races | §3 `tret_` retirement with epochs, reader filtering and owner self-retire; serial `PublishQueue` and `publishGeneration` for disable; offline-return and in-flight tests. |
| P1 Active-only capture loses positions | §5 `TabStateCache`, event and sampled triggers, outgoing-tab capture, `navSeq` binding; flush is best effort. |
| P2 `revs_limit: 20` conflicts | §4 owner `seq`, `(epoch, seq)` winner, continuous reconciliation in live sync; >20-publish test. |
| P2 Routing drops non-`sto_` docs | §8 both paths (`notifyRemoteChanges`, local observer), tombstones, initial cached load; two-runtime test. |
| P2 Banner excludes long sessions; stale and skew issues | §6 `selectedAt`/`activityAt`/`capturedAt`, live-observed vs initial freshness, skew tolerance; tests. |
| P2 `installNonce` can't detect clones | §1 clone detection unsupported in v1, "Reset device identity", identity init under Web Lock. |
| Mobile JS eval exists | Uses `InAppBrowserSurface.evaluateJavaScript`. |
| Reader needs a host adapter | `host: "reader"` and `ReaderStateHost` in the provider contract; Electron reader handled separately. |
| Send retention unbounded | Any device GCs sends older than the synced retention (default 14 days) or sent to retired targets. |
| Toggle scope and defaults | §2 device-local option table; sharing is opt-in. |
| Domain exclusion inconsistency | Excluded domains are in v1 (`tabFilter`, settings). |

## Review changes (round 5 → rev 6)

| Finding | Resolution |
|---|---|
| P1 Destination binding misses background-only use and startup/browser-synced URL changes | §9 binds before transport startup, persists device-locally, guards replication and every HTTP operation, handles URL changes with connection generations and preserves migration provenance; startup and background-only tests. |
| P1 Firefox capture toggles cannot gate existing unfiltered replication data | §4a requires all three categories for the connection and gates startup, queued work, retries and revocation across panels/background; upgrade and revocation tests. |
| P2 Live delivery does not prove snapshot freshness | §6 applies a conservative source-timestamp check to every delivery path, states the clock-skew limitation and never renews age on receipt; delayed-live-delivery test. |
| P2 Chrome activation has no `previousTabId` | §5 persists a per-window active-tab map across worker suspension, with optional Firefox shortcut and lifecycle cleanup; Chrome-shaped event tests. |
| P2 Incoming-send query has no upper bound or target validation | §4a bounds and paginates the exact inbox prefix, retrieves bodies and revalidates the target before actions; two-target and identity-reset tests. |
| P2 30-second alarms require Chrome 120, but the manifest supports 114 | §4a and phase 2 explicitly raise the minimum to 120; manifest and packaged-alarm verification. |
