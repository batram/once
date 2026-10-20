# Gecko startup improvements and deeper profiling — Samsung, 2026-10-20

Follow-up to `once-gecko-startup.md`, against baseline `fd929045`. All four identified changes are implemented. They remove redundant work and catalog errors, but this benchmark does **not** demonstrate a material reduction in total cold startup time.

## Changes

- Catalog callers share one pending native list request. Icon/action change bursts are debounced, with a trailing refresh when another change arrives during the query. Gecko's initial catalog is shared instead of immediately listing again after bundled-extension preparation. Later requests still query current installs and enabled state.
- The Violentmonkey relay returns reconciliation records and the script export together. Unchanged records are not rewritten. A per-background revision token lets subsequent hand-offs of the same document skip export and planning. Script changes, record writes, mutation commands and process restarts invalidate the token; edits during a snapshot read invalidate that snapshot and still generate a dashboard-change notification. The first cold connection still reads scripts, and two-way reconciliation and the document-start barrier remain intact. Lite implements the combined snapshot contract too; its responses do not advertise the Gecko token fast path.
- Android range iterators optionally return their first bounded page with `iteratorOpen`. Page SQL reads keys and values together instead of issuing an additional value query per row. The adapter prefetches document metadata/bodies for the returned first page just as it does for subsequent pages. Point snapshots retain their separate batching path. WAL snapshot lifetime, ordering, row limits, the byte budget and large-value support remain unchanged. Legacy callers that do not request an initial page retain their protocol.
- A Violentmonkey connection waits for the initial settings hand-off, then reads/applies userscripts only. It no longer reapplies filter lists. Actual settings-change events still apply the full settings document, and superseded reads cannot reinstall stale scripts.

A phone trial also exposed an existing deployment mismatch: `package` refreshed adapted extension assets but `deploy` did not. The shared Android sync path now refreshes pinned bundles/adaptations before building. The new shell has a narrowly scoped compatibility fallback when an older relay explicitly rejects `OnceReadSnapshot`; arbitrary transport or storage failures do not turn into empty snapshots. A CLI regression test exercises the real deploy script with fake process boundaries.

## Normal benchmark results

Same Samsung SM-G780G, Android 13, GeckoView 155.0.20260903215306, production-channel debug app and retained profile: 31 configurations, five userscripts, no supplemental lists, and four user-visible extensions plus the Once bridge. Foreground and unlocked. Each normal trial force-stops the process, observes the shell for 15 seconds, then opens the same tiny local HTTP fixture through ADB reverse. First-page measurements start at the native open request, separately from app launch.

| Metric | Baseline | Final |
|---|---:|---:|
| First saved stories, median, n=5 each | 1,955 ms | 1,975 ms |
| Configurations visible, median, n=5 each | 1,999 ms | 2,018 ms |
| First native open resolves, median | 1,612 ms, n=4 | 1,683 ms, n=5 |
| First native open, range | 1,401–1,830 ms | 1,230–1,749 ms |
| First local page reports loaded, median | 2,299 ms | 2,400 ms |
| Native calls begun before first stories | 62 | 56 |
| `iteratorNext` calls begun before first stories | 11 | 5 |
| Catalog queries per first open | 8 | 1–2 |
| Catalog “already in progress” errors | 6 | 0 |
| Filter reapplications on VM connection | 1 | 0 |
| Normal unchanged userscript native calls | 5 | 3 |

Saved-content startup is effectively flat; first-page medians are slightly higher in this sample, within overlapping observed ranges. The runs were sequential with real sync/feeds retained, not randomized A/B. Thermal status 1 was observed after the series. Neither that observation nor the lower operation count establishes a causal timing improvement.

The live relay token check returned all five scripts on the full read, then returned `unchanged: true` in **4.8 ms** for the repeated read. This demonstrates the warm reconciliation fast path, not a 4.8 ms cold hand-off. Full first-connection snapshot calls in the five final trials took 223–378 ms, including extension startup, storage, export, native-message and shell callback delays.

Excluded from the normal comparison: the post-install warmup; the stale-relay failure that waited for the 15-second barrier timeout before the deployment fix; native debug tracing; and both profiler runs. No extension was disabled to improve results.

## What remains on the critical path

### Native database work

An opt-in `OnceDatabasePerf` log separates worker queue time from dispatch/response-enqueue execution. It logs operation names and timing only, no keys or data. Enable it with Android's log-tag property for diagnostics; it is disabled again on the phone.

One instrumented restart observed 45 native database operations completing before initial stories, with about **423 ms total serialized execution**. The largest individual operations included `getMany` at 80 ms, database open at 62 ms, range open/first-page read at 42 ms and close at 35 ms. Queue waits overlap other operations and must not be added to execution totals as independent work. The instrumented restart followed an install and is not part of the latency comparison.

The next storage investigation should distinguish SQL/blob reads from base64/JSON marshaling inside `getMany`, and assess duplicated database validation/open/close work before the application opens its store. Reusing prepared statements inside multi-key reads is another candidate. The current evidence does not justify attributing every long JS-observed database call to SQLite or relaxing snapshot/durability guarantees.

### Gecko process/session startup

A representative unprofiled final trial (`final-open-5`) shows:

| Milestone | Since Gecko thread launch |
|---|---:|
| Libraries ready | 35 ms |
| JNI ready | 129 ms |
| Profile ready | 250 ms |
| Gecko running | 291 ms |
| Bootstrap blank session starts | 918 ms |
| First background native-port connections | 1,137 / 1,251 ms |
| Requested page starts | 1,694 ms |
| Once page-ready signal | 2,389 ms |

A separate **5 ms JS-only Gecko startup profile** covered 235 parent-main-thread samples between thread launch and requested-page start. The biggest recurring named path was `geckoview.js startup/init → browser-custom-element construct → loadContext`, present in 45 samples (about 19%). A separate stack-walking capture resolved the underlying path through `ContentParent::CreateBrowser`, `nsFrameLoader::TryRemoteBrowser:Create` and `ShowRemoteFrame`. This includes synchronous waiting; it is not evidence of 225 ms of JavaScript CPU consumption.

Extension API-schema setup, Violentmonkey background initialization and Dark Reader site-fix indexing also appeared. uBlock functions appeared in smaller sampled groups. The profile does not support treating extension module fetches as the dominant remaining problem. Sampling is too coarse to assign precise costs to small functions.

The stack-walking 2 ms profile perturbed native open to 4.54 seconds and was excluded. The lighter JS-only run opened in 1.23 seconds and reported the fixture at 1.81 seconds; it remains a diagnostic, not an extra favorable benchmark sample. Raw profiles and logs remain in ignored artifacts because they may contain browsing/profile information; only sanitized summaries are in the result JSON.

The next concrete experiment is to **overlap blank-session/content-process creation with bundled-extension preparation**, rather than waiting for the catalog before starting the session. The requested URL must remain behind filter and userscript readiness, with delegate attachment, cancellation and first-install behavior tested. This change is not included here. Eagerly starting Gecko during story-list startup would shift work and memory earlier and should be evaluated separately.

## Validation

- 330 mobile tests passed, including the new catalog concurrency/trailing-refresh, startup race, snapshot-token invalidation, old-relay fallback, Lite snapshot-contract and range-iterator tests.
- Type checks, lint, structural limits, package boundaries and whitespace checks passed.
- Final production-channel debug APK built, installed and exercised on the Samsung.
- Real Java storage probe: 272-document conformance, 3.6 MB attachment, transaction rollback, first-page and subsequent-page snapshot isolation, reverse paging, zero limits, keys-only reads and oversized-row paging passed in an isolated temporary database.
- Live extension settings checked at the Samsung's 360×800 CSS viewport in light and emulated dark appearance. Four extension rows were 336 px wide with no horizontal overflow; icons populated, repeated refreshes produced no error, detail and Back navigation worked. Relevant catalog/UI tests were rerun afterward.
- The profile's five userscripts and installed extensions remained present. No permissions or enabled states were changed. Temporary profiler YAML, native timing property and ADB forwards were removed, and the app was restarted normally.
