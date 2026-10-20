# Once Lite: detailed startup investigation

Measured 20 October 2026 on commit `eb761777`, following the
[a615e626 review](once-lite-samsung.md). Individual samples and aggregates are
in [once-lite-startup-detail.json](once-lite-startup-detail.json).

## Implemented follow-up

Keyed extension storage and initial registration batching are now implemented
and installed on the same Samsung. The measurements in this section use the
actual implementation without the diagnostic overrides described later.

`JsonStore` now optionally supports keyed reads. `ExtensionStorage` uses them
when the host also supports patches, remembers missing keys, serializes loading,
and merges a later full enumeration without replacing locally changed or removed
values. Partial-cache patch failures retain dirty keys for retry rather than
writing an incomplete whole document. Hosts without keyed reads retain their
whole-document behavior and recovery.

Lite's native read protocol accepts a key selection. Split stores open only
those value files; legacy unsplit documents are scanned without materializing
discarded values. Selected large values retain the bounded chunk transport.
Empty and long storage keys are supported by the split-file naming scheme.

`LiteWorlds.batchRestore()` defers both explicit and scheduled updates during
restoration. One final update installs the surviving host set, including after a
restore failure. Startup awaits its native acknowledgement. Subsequent
extension loads and script changes retain their normal update behavior.

### Samsung results

Five process-cold launches with retained data/caches, compared with the three
unmodified launches from the investigation. Same debug-build configuration,
both extensions enabled, five configurations and 110 stories. The first launch
after APK installation is included. The samples are not paired and the small
dataset cannot establish a statistically reliable improvement in story loading.

| Milestone | Before median | Implemented median | Implemented range |
| --- | ---: | ---: | ---: |
| Extension hand-off complete | 4,862 ms | **3,199 ms** | 3,086–3,451 ms |
| Source configurations | 2,275 ms | 2,424 ms | 2,307–2,844 ms |
| First stories | 2,783 ms | 2,741 ms | 2,676–3,732 ms |
| All 110 stories | 3,128 ms | 2,848 ms | 2,739–4,197 ms |

Extension readiness improves by **1,663 ms / 34%**. All five implemented runs
observe one initial world registration and successful uBlock selfie restoration.
The longest observed uBlock storage get per launch has a median of **77 ms**
(40–123 ms), down from **1,651 ms** (1,577–1,692 ms). A representative launch
loads only five present storage values totaling **5,760 serialized characters**,
versus 36 values totaling about 29.4 million previously. Missing requested keys
are cached separately. The single registration carries 930,328 source
characters; rebuilding the bundle changes this slightly from the earlier
diagnostic source count.

### Deeper asset-loading measurements

Three additional, separately instrumented cold launches traced file-reader
calls, broker request handling and `Fetch.fulfillRequest` acknowledgements.

| Measurement | Run 1 | Run 2 | Run 3 |
| --- | ---: | ---: | ---: |
| uBlock navigation → DOMContentLoaded | 1,110 ms | 1,212 ms | 1,321 ms |
| Total time in 69 file-reader calls | 181 ms | 177 ms | 184 ms |
| Median broker asset-service elapsed time | 135 ms | 143 ms | 186 ms |
| Median service start → fulfill command | 71 ms | 69 ms | 85 ms |
| Median fulfill command → broker acknowledgement | 76 ms | 72 ms | 103 ms |

There are 64 fulfilled uBlock resources including the document. File-reader
time includes synchronous native-interface work, decoding and cache checks,
not just filesystem I/O. The longest individual file-reader calls take roughly
9–15 ms. Request durations overlap: the rows cannot be added to obtain startup
time, and the gap before a command includes scheduling among other requests.

A fourth trace enabled the existing `OnceLiteFetch` native debug logs and
correlated their device wall clock with the broker's clock. Across 64 requests,
median delays were:

- Native pause forwarding point → broker receives pause: **77.5 ms**.
- Broker issues fulfillment → native logs the command before sending CDP:
  **38.8 ms**.
- Native CDP send point → broker receives acknowledgement: **82.3 ms**.

That last interval includes CDP execution, native reply delivery and renderer
scheduling; the existing log does not separate them. Logging itself adds
overhead, so this trace is attribution evidence, not the startup benchmark.
The log property was restored after measurement.

To isolate the value of the reader's file cache more closely, six alternating
reloads were run after application startup, with Chromium cache bypass enabled.
Three retained the broker's file-reader cache and three cleared it. All restored
the compiled filter snapshot successfully:

- Reader cache retained: DOMContentLoaded **307 ms median** (296–370 ms).
- Reader cache cleared: **450 ms median** (439–467 ms).

This roughly **143 ms** difference supports file caching as a useful but smaller
opportunity. These warm reloads retain the process, target attachment, extension
storage and other caches; they do not predict process-cold startup directly.
The much larger cold-start delay implicates concurrent startup work and message
delivery/scheduling as well as file reads.

The next optimization to prototype is a native fulfillment path for authorized
bundled extension assets: keep permission decisions in the broker, but avoid
sending asset bytes through synchronous Java → JS reads, response construction,
base64 encoding and JS → Java JSON transport. Fewer module requests through
bundling/preloading may also reduce repeated dependency-wave round trips.
Both need their own end-to-end experiments; no saving beyond the implemented
storage/registration changes is claimed here. Own-page, frame-origin,
web-accessible-resource and CORS rules must remain intact.

### Validation and final device state

- 114 JavaScript runtime/Lite tests passed, including partial-cache recovery,
  overlapping reads, enumeration during local mutations, registration batching,
  restore failures and native-acknowledgement gating.
- 45 JVM tests passed, including selected reads of legacy and split documents,
  empty/long keys, missing keys and an unrelated unreadable cache value.
- Six Samsung instrumentation tests passed: all five engine regression tests
  plus the new legacy/split/chunked keyed-storage round trip with deletion.
  The engine suite covers the bundled extensions, filtering/userscripts,
  extension page reload, target readiness, synchronous requests and broker
  renderer recovery.
- Package build, mobile type checking, lint, structural limits, package
  boundaries and whitespace checks passed.

Instrumentation used the separate dev package. The production-identity app was
restarted afterward with diagnostic injections removed and native debug logging
restored. The installed APK was compared against the built APK by SHA-256.
No filter caches or application data were cleared.

## Initial diagnostic investigation

The largest confirmed remaining waste is eager loading of uBlock's entire
extension storage document to answer requests for individual settings.
Avoiding that work in a temporary experiment reduced median extension
readiness from 4.86 seconds to 3.28 seconds. Coalescing initial content-world
registrations as well reached 3.18 seconds. These are diagnostic experiments,
not shipped optimizations.

## Method and limits

- Same Samsung SM-G780G, Android 13, WebView 155.0.8059.43, production package
  identity `com.zmarn.once.lite`, debug APK, both extensions enabled.
- Existing profile retained: five source configurations and 110 stories.
  Process-cold launches; no clearing of application data or filesystem caches.
- Three runs per condition, interleaved, with CDP instrumentation. All times
  below are milliseconds from the host launch request, calibrated against the
  shell performance clock. They include launch-command overhead. DOM milestones
  are not optical measurements.
- A separate CPU-profiled launch is used for attribution, not included in the
  timing comparison. The shared renderer profile includes shell, broker and
  extension work; separate target profiles must not be summed.
- Small sample sizes, instrumentation overhead, background synchronization,
  thermal state and OS scheduling limit precision. These measurements are not
  release-build benchmarks or clean-install/cold-cache benchmarks.
- Raw diagnostic traces and temporary probes are retained locally under
  `artifacts/lite-startup-detail/` (ignored by Git). They are not required to
  read the checked-in aggregate results.

## Where the time goes

One representative unmodified run, `stock-2`, reached extension readiness at
4,854 ms. The phases overlap.

| Time after launch | Observation |
| --- | --- |
| 572 ms | Shell document clock begins; preceding Android/WebView work is not subdivided by this trace |
| 1,041 ms | Application reaches platform initialization |
| 1,541 ms | Application starts loading saved state |
| 2,271 ms | Shell reports ready |
| 2,275 ms | Five source configurations populated |
| 2,636 ms | First 25 stories |
| 4,427 ms | All 110 stories; another background source refresh follows |
| 4,854 ms | Initial extension settings and userscript hand-off complete |

The extension lane runs concurrently:

| Interval after launch | Work |
| --- | --- |
| 1,078–1,548 ms | First content-world update, including source construction and native acknowledgement |
| 1,632–1,795 ms | Second content-world update |
| 2,018–2,120 ms | Third content-world update |
| 1,323–2,386 ms | uBlock background navigation through DOMContentLoaded |
| 2,411–4,062 ms | First uBlock `storage.local.get(["localStorage"])`; `hiddenSettings` joins the same load |
| 2,411–2,796 ms | Native whole-store read request, including joining split files and queue/bridge latency |
| 2,796–4,008 ms | Chunk transfer, synchronous native calls, decoding and cooperative yields |
| 4,008–4,062 ms | Final assembly/parse/map completion |
| 4,062–4,854 ms | Remaining uBlock startup, filter settings checks, settings acknowledgements and userscript relay |

This last interval is not exclusively CPU work or filtering: it contains
asynchronous waits and overlapping settings applications. Likewise, multiple
`applySettings` calls waiting on the same readiness promise do not represent
multiple independent filter compilations.

## 1. Eager extension storage is the main confirmed bottleneck

`ExtensionStorage.load()` calls `store.read(name)` before every first `get`,
even when the caller requests one small key. The uBlock document contains
36 keys and about 29.4 million serialized value characters:

| Stored value | Approximate serialized size |
| --- | ---: |
| `cache/selfie/staticNetFilteringEngine` | 15.18 million characters |
| `cache/compiled/urlhaus-1` | 2.33 million |
| `cache/selfie/staticExtFilteringEngine` | 1.83 million |
| `cache/compiled/easylist` | 1.74 million |
| `cache/easylist` | 1.45 million |
| Remaining values | 6.85 million |

These are character counts, not heap measurements or exact UTF-8 file sizes.
The native store already has a split-per-key representation, but its read API
joins the entries into a temporary JSON document. JavaScript then transfers,
decodes and parses the entire document.

In the separate CPU-profiled launch, `readChunks` accounts for about 1.23 seconds
of sampled time. This includes time attributed to its synchronous native calls;
it should not be interpreted as 1.23 seconds of pure JavaScript computation.
The corresponding storage load took 1.62 seconds wall time.

uBlock already reports `cacheBackend: indexedDB` and `allReadyAfter: ... (selfie)`
in every comparison run. It is restoring a valid compiled snapshot. The
storage.local copies are still present because upstream `cachestorage.js`
writes both its fast cache and extension storage. Thus the current comment in
`ExtensionStorage.ts` describing this as a small settings document is incorrect
for this profile.

**Recommended implementation:** add keyed native store reads and lazy per-key
loading in `ExtensionStorage`, including batched requests and missing-key
caching. Preserve full enumeration for `get(null)`, default-value semantics,
old values/change notifications, clear/remove, write ordering, failed-write
recovery and legacy unsplit documents. Retain the cache fallback when IndexedDB
is unavailable. Startup must not fall back to reading everything on its first
`set` or `remove`.

The experiment seeded the in-memory map with current non-cache settings plus
the required small bad-list cache, about 87.5 thousand JSON characters, and
suppressed uBlock storage flushes. Large IndexedDB caches remained available.
This isolates the potential savings; it is not a complete storage adapter and
does not measure the real cost of a future keyed native read.

## 2. Initial content-world registration is repeated

`LiteBroker.load()` awaits `worlds.update()` for each restored extension.
`handleStart()` then calls it again after `manager.restore()`.
The three messages carry 501,662, 928,852 and 928,852 source characters,
respectively: 2.36 million characters overall.

In `stock-2`, the three complete update calls occupy 470, 163 and 102 ms.
Only some of this is on the final readiness critical path because background
page loading overlaps it.

**Recommended implementation:** batch registrations during initial restore,
send the final complete set once, and await its acknowledgement before
releasing navigation. Preserve updates for subsequent extension/script changes
and handle partial restore failures. Do not hard-code an assumed count of
extensions.

The experiment skips the first two update calls for this known two-extension
profile, then performs the third. It tests the potential saving, not the
generality or correctness of a production restore-batching implementation.

## 3. Local extension asset loading is the next investigation target

In `stock-2`, uBlock's background document reaches DOMContentLoaded 1.064 seconds
after navigation begins. It records 63 resource entries with about 1.53 MB of
decoded resource bodies. Another run takes 1.391 seconds to DOMContentLoaded;
many individual local JavaScript requests take 200–400 ms.

These are overlapping requests, not 63 serial delays. Navigation timing also
includes script execution and scheduling, so it does not establish the amount
recoverable by changing asset delivery.

The code path explains a plausible source of overhead: extension requests are
paused by CDP, routed through broker permission checks, read into a response,
converted to an ArrayBuffer and base64, then returned with
`Fetch.fulfillRequest`. The module graph produces several waves of requests.
Background pages also wait for target attachment, with several serial CDP
domain-enable calls before navigation.

**Next experiment:** instrument request pause → broker receive → file read →
fulfill → renderer completion, plus target attachment/domain setup. Then test
a native fast path for authorized bundled assets, fewer module requests through
bundling/preloading, or safe setup parallelism. Preserve extension own-page,
web-accessible-resource, frame-origin, CORS and cancellation rules.
No measured end-to-end saving is claimed for these ideas yet.

## Controlled comparisons

| Condition | Extension-ready median | Observed range | Difference from stock median |
| --- | ---: | ---: | ---: |
| Unmodified installed code | 4,862 ms | 4,854–4,959 ms | — |
| Small settings preseeded; whole-store read avoided | 3,275 ms | 3,208–3,524 ms | −1,587 ms (33%) |
| Only final initial world registration | 4,612 ms | 4,537–5,002 ms | −251 ms (5%) |
| Both diagnostic overrides | 3,179 ms | 3,042–3,204 ms | −1,684 ms (35%) |

The savings are not additive. The registration-only ranges overlap stock,
so the small measured gain needs more samples after implementation.
All runs report successful selfie restoration. After the final metadata
experiment uBlock contains 260,221 network filters and 44,204 cosmetic filters;
the fresh unmodified restart has the same counts. This is a restoration sanity
check, not a full blocking-correctness suite for either proposed optimization.

## General application startup

The stock median is 2,275 ms for configurations, 2,783 ms for first stories and
3,128 ms for all 110 stories. Full-story completion varies from 2,863 to 4,427 ms.
Removing extension storage work primarily improves protected browser readiness;
this small sample does not demonstrate a consistent first-story improvement.

The representative trace spends about 500 ms between platform initialization
and `app.start`, then 723 ms in saved-state startup before mounting the UI.
`main.ts` serially awaits database preparation, reading-controller setup,
image-text setup, source-picker setup and back-button registration.
`AppRuntime.start()` loads several independent settings in parallel but also
awaits sync startup before returning.

Instrument those individual awaited steps next. Candidates are deferring
nonessential reader/picker services until use, avoiding repeated secure-settings
bridge reads, and separating data required for the initial story/configuration
view from synchronization startup while preserving destination/consent
semantics. These are code-informed candidates, not quantified savings.

Some native calls appear very slow while extension work is running: one
`getMany` and one secure-settings read each take about 1.27 seconds in
`stock-2`. Their elapsed durations include callback scheduling in the shared
renderer and do not prove slow SQLite or secure storage. Native-side timestamps
are needed to split execution from queued delivery.

## Initial investigation result

No production code was changed during the initial diagnostic investigation. The phone was restarted
without the diagnostic injections; the normal storage adapter and registration
path are active. The proposed order is keyed storage first, restore registration
batching second, then asset-delivery/target-attachment measurements and the
remaining shell initialization awaits. Keep the extension navigation barrier:
moving the ready signal earlier would conceal the delay rather than remove it.
