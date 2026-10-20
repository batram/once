# Once Android GeckoView startup — Samsung, 2026-10-20

The Lite module-delivery work was committed as `fd929045`. This investigation benchmarks regular `com.zmarn.once`, first as installed (last updated October 18), then with a production-channel debug APK built from that commit. It adds no runtime optimization. Existing shared startup fixes are present in the newer APK; Lite-specific extension bundles do not apply to Gecko.

## Device, profile, and method

Samsung Galaxy S20 FE SM-G780G, Android 13, GeckoView `155.0.20260903215306`. Unlocked, foreground app. App data, caches, permissions, extensions and settings retained. This profile has 31 source configurations, five userscripts, zero supplemental filter lists, and the Once bridge, uBlock Origin, Violentmonkey, Dark Reader and SponsorBlock. It differs materially from the Lite benchmark profile.

Five process-cold launches per build, observed through the Capacitor shell's CDP endpoint. Time zero is the host's activity-launch request, with document time calibrated by a midpoint CDP clock sample. Counts and timing metadata only are in the accompanying JSON; raw traces remain under ignored `artifacts/gecko-startup-detail/`. Feeds and sync remained enabled and changed story counts naturally. This sequential comparison is not a randomized A/B experiment; the approximately 180 ms improvement is an observation, not an isolated causal estimate.

The shell-only launch does **not** start Gecko. Native `load()` avoids creating the runtime; the first page or extension-manager request starts it. The shell's `once:extensions-ready` mark does not mean Gecko backgrounds are ready: handing settings to an engine that is not running also completes that shell stage.

For browser startup, after a 15-second shell observation window, invoke the production native `open` path for a tiny local HTML fixture through `adb reverse`. Its load handler posts a Navigation Timing report. This exercises the engine, existing extension profile and userscript/settings barriers. It excludes internet latency but includes reverse-tunnel transport. The host report metric includes the report request too; it is not a paint metric. Close the temporary native surface after each test. Warm trials repeat the open in the same process.

## Results

| Milestone | Older installed build | Current build |
|---|---:|---:|
| First saved stories, median of 5 | 2,138 ms | 1,955 ms |
| First saved stories, range | 2,041–2,771 ms | 1,919–2,031 ms |
| Source configurations, median of 5 | 2,183 ms | 1,999 ms |
| Configurations, range | 2,089–2,811 ms | 1,962–2,073 ms |
| First native open resolves, median | 1,594 ms, n=3 | 1,612 ms, n=4 |
| First local page report, median | 2,173 ms, n=3 | 2,299 ms, n=4 |

The initial rendered batch contains 17 saved stories and all 31 configurations follow shortly afterward. Subsequent saved-story batches and feed refreshes continue. These numbers do not claim all feeds have finished loading.

Current first-open calls span 1,401–1,830 ms; local page reports span 2,020–2,575 ms. No demonstrated Gecko first-open improvement from updating the shared shell. Two warm opens return in 23 and 12 ms, with page reports at 226 and 206 ms. The current first measured restart after install is recorded separately (2,068 ms first stories; 1,932 ms first open); deploy itself launches the app, so this is not a pristine first post-install launch.

## Where the time goes

A representative current shell launch (`current-3`, 2,031 ms to first stories):

| Interval | Approximate duration |
|---|---:|
| Activity-launch request → document time origin | 618 ms |
| Document origin → platform setup begins | 428 ms |
| Platform/database preparation | 135 ms |
| App startup, saved-data reads and first UI mount | 850 ms |
| First stories → configurations present | 42 ms |

In that launch, before first stories appeared, the probe observed 21 `getMany`, eight `iteratorOpen`, eleven `iteratorNext`, and six `iteratorEnd` calls, plus writes, secret reads and setup calls. Two concurrent range-open calls each took about 230 ms end-to-end. Their time overlaps; do not sum it. Native calls include scheduling, SQLite work, bridge serialization and JS callback delay.

A separate CPU-profile launch shows about 679 ms of sampled idle time in the roughly 1.22-second observed interval preceding initial UI readiness, about 149 ms in V8's unattributed `(program)` category, and smaller JS costs. Module initialization, base64/Buffer conversion and rendering appear, but there is no single dominant JS function. The approximate alignment starts at the probe-attachment timestamp; this is supporting evidence, not precise native-I/O attribution.

For one representative cold first-page trial (`current-open-3`), native log timestamps show:

| Native milestone | Time since Gecko `LAUNCHED` |
|---|---:|
| Libraries ready | 41 ms |
| JNI ready | 158 ms |
| Profile ready | 213 ms |
| Gecko running | 244 ms |
| Bridge delegate attachment visible in logs | 358 ms |
| Bootstrap `about:blank` starts | 725 ms |
| First two background native-port connections | 971 / 1,012 ms |
| Requested local page starts | 1,423 ms |
| Once page-ready signal | 1,971 ms |

These are observed milestones, not mutually exclusive CPU buckets. The gap to bootstrap/background ports includes process startup, extension startup and concurrent application work. The native open call resolves in 1,401 ms in this trial, shortly before the page-start event. Host and device wall clocks have an offset; use within-log deltas rather than subtracting device timestamps from host timestamps.

One post-start Firefox debugger snapshot reports background document load endpoints of 204 ms (bridge), 223 ms (Violentmonkey), 218 ms (Dark Reader), 346 ms (uBlock), and 54 ms (SponsorBlock), relative to each background document. Background document load is not completion of uBlock filter restoration. Resource Timing entries were empty in this Gecko profile, so there is no defensible per-module fetch breakdown from that snapshot. These observations do not justify porting the Lite bundling transform to Gecko yet.

## Highest-value next changes

1. **Coalesce extension catalog refreshes and keep icon work out of the first-page critical path.** All four current cold-open traces show eight `extensionCommand` requests, of which six fail because another operation is in progress. `GeckoExtensionManager.onBrowserAction` and individual icon completions emit changes; `browserExtensionSettings.ts` lists on every event even while the settings page is hidden. Successful list operations re-adopt extensions, and the initial `ready()` callers request another list after the engine already listed them. Use a shared pending refresh plus one trailing refresh, and separate installed-catalog changes from icon/action presentation updates. Preserve live changes after install, enable, disable and update. The redundant work is proven; net time savings are not yet measured.

2. **Make unchanged userscript reconciliation cheap while retaining two-way synchronization.** The five-script profile performs `OnceReadRecords` → `handingOff` → `ExportZip` → `OnceWriteRecords` → `settled` on first engine connection. From the first record read to settlement this takes approximately 247–430 ms in the four current runs. `ExportZip` alone takes 81–173 ms and exports all script code; record reads take 89–237 ms. A relay command can return the records and installed-script snapshot together, followed by a revision/digest fast path for unchanged scripts. Avoid rewriting unchanged records. Any fast path must detect dashboard edits, deletion, toggles, normalization and extension restarts; retain the document-start navigation barrier. The full 247–430 ms is a budget to investigate, not promised savings.

3. **Optimize app database range reads.** This affects story-list startup even when Gecko never starts. `NativeDatabasePlugin.iteratorOpen` opens a new read-only SQLite connection and pins a WAL snapshot. `iteratorNext` selects keys, then performs a separate value read per key. Investigate returning the first page with iterator creation, bounded connection reuse with a fresh transaction, and selecting values in the same query without removing the current byte limit or snapshot guarantees. Preserve concurrent-write isolation, paging order, large values, attachments and cleanup. Native spans should distinguish queue time, connection setup, SQL and serialization before attributing the 230 ms observations solely to SQLite.

4. **Avoid repeating filter-list work on a Violentmonkey-only connection.** `mobileExtensionSettings.ts` calls the full settings apply path when Violentmonkey connects. The bridge fetches and parses enabled supplemental lists on application. This profile has no supplemental lists, so that repetition is not the measured large cost here. With configured lists it can introduce avoidable network work; cache by revision/content and preserve changed-list application and failure semantics.

5. **Consider intent-driven Gecko warm-up after reducing the redundant work.** The cold/warm difference is substantial, but eager startup would spend memory and CPU even when the user only reads the story list. Measure a warm-up triggered by browser intent or a restored browser tab, keeping navigation behind extension readiness. Do not treat moving cost earlier as reducing total startup work.

## Validation and limits

Both Android Gecko release packaging and production debug deployment succeeded. Five cold shell launches per build, three older/four current cold first-page trials, two warm trials, an additional CPU-profile launch and a post-start extension debugger snapshot completed. No new runtime code or permission changes were made in this investigation, and no extension was disabled for an attribution experiment. This is a debug-build benchmark, not a signed release comparison. The test fixture does not represent complex websites or Dark Reader's styling cost on real pages. All profiling hooks disappear on process restart; temporary forwards are removed and the regular app is left running normally.
