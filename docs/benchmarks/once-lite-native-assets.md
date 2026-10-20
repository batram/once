# Once Lite: native extension assets and remaining startup time

Measured 20 October 2026 on Samsung SM-G780G, Android 13,
WebView 155.0.8059.43. The baseline is `d8bc2418`, which includes keyed
extension storage and batched initial registrations. Samples and aggregates
are in [once-lite-native-assets.json](once-lite-native-assets.json).
The preceding investigation is in [once-lite-startup-detail.md](once-lite-startup-detail.md).

## Implementation and permissions

The shared extension protocol now resolves a request into either an existing
generated/error response or an authorized package file plus response headers.
It performs the same extension lookup, web-accessible-resource check, one-use
own-page grant and path normalization before returning a file descriptor.
The existing protocol response API uses this resolver too, preserving the
non-native hosts' behavior.

Lite keeps its webRequest cancellation and requesting-frame checks in the
broker. An authorized file request sends `Fetch.fulfillExtensionAsset` with a
directory, relative path and headers, rather than file bytes. Native code reads
and base64-encodes the bytes on a bounded two-thread executor, then fulfills the
paused request directly through CDP. It checks that the attachment still names
the same live target before sending.

Generated backgrounds and denied requests retain the existing broker response
path. Missing files return 404. MIME types, extension CSP and caller-specific
CORS grants are retained; binary files are transferred as bytes. Native file
access retains the existing path normalization and canonical storage-root checks.
Package directory/path metadata never goes into the actual CDP fulfillment.

This removes the native → JavaScript file-body transfer, JavaScript response
construction/encoding, and JavaScript → native body JSON transfer. CDP still
requires base64 encoding, now done natively.

## Before and after

Five process-cold launches before and five after, retaining the configured
profile and caches. Both bundled extensions are enabled; five configurations
and 110 stories are present. The debug APK uses the production package identity.
The first launch after installation is included.

Initial attempts encountered Android's PIN panel over the activity and showed
background throttling. Those attempts were excluded. After the user unlocked
the phone, a fresh complete baseline was collected with Once in the foreground.

Times are milliseconds from the host launch request, calibrated to the shell's
performance clock. The uBlock DOMContentLoaded row instead measures from that
background document's navigation start. CDP/DOM timing is not optical display
timing. The before/after series is sequential, not randomized or paired;
background activity and small sample sizes limit precision.

| Milestone | Before median (range) | Native assets median (range) |
| --- | ---: | ---: |
| Extensions ready | 3,699 (3,391–4,201) | **3,355 (3,112–3,906)** |
| uBlock document → DOMContentLoaded | 1,366 (1,181–1,504) | **958 (877–1,129)** |
| Configurations populated | 2,480 (2,195–3,033) | 2,279 (2,152–2,940) |
| First stories | 2,943 (2,858–3,392) | 2,697 (2,615–3,329) |
| All 110 stories | 3,006 (2,922–3,970) | 2,822 (2,691–3,938) |

The extension-ready median improves **344 ms / 9.3%**; uBlock's document-loading
median improves **408 ms / 29.9%**. Story/configuration medians also improve in
this sample, but their ranges overlap substantially. All measured launches
restore the compiled uBlock snapshot successfully.

Use this session's fresh baseline for the comparison. The earlier investigation
measured about 3.20 seconds on `d8bc2418`; absolute timings vary between series.
These numbers measure startup readiness, not website network load time.

## Did the asset bytes leave the broker?

Three separate diagnostic cold launches observed:

- **66 native asset commands per launch**, across the bundled extensions.
- **Zero asset-body characters in those broker commands**.
- **Five observed uBlock file-reader calls**, taking 17–20 ms total. These are
  remaining initialization/content-source reads; the earlier asset trace
  observed 69 calls taking 177–184 ms.
- Median broker asset-service entry → native-command dispatch of approximately
  **0.1–0.2 ms** for the uBlock requests.
- Median native asset command → broker acknowledgement of **84–134 ms**,
  including native work and asynchronous reply scheduling.

Acknowledgement delays overlap and can outlast the renderer's receipt of a
resource. They are not additive startup costs. The earlier file-reader timings
are from the preceding investigation, not a second randomized comparison.

## Where the remaining startup time goes

One ordinary post-change launch (`native-asset-after-3`) reached extension
readiness at 3,270 ms. The shell and extension lanes overlap:

| Time after launch | Event or interval |
| --- | --- |
| 605 ms | Shell document clock begins |
| 1,195 ms | Application reaches platform preparation |
| 1,195–2,055 ms | Platform/database preparation and controller installation |
| 1,499 ms | uBlock background navigation begins |
| 1,719–1,978 ms | Final content-world update, including source construction and native acknowledgement |
| 1,499–2,385 ms | uBlock background document loads and reaches DOMContentLoaded |
| 2,055–2,498 ms | Application saved-state startup before UI mounting |
| 2,509 ms | Source configurations populated |
| 2,754 ms | First stories |
| 2,927 ms | All 110 stories |
| 3,270 ms | Initial extension hand-off complete |

Within platform preparation, observed calls include `getSyncUrl` at 172 ms,
database pointer reading at 77 ms, database opening at 129 ms and a database
batch at 118 ms. These are JavaScript-observed elapsed durations, including
native execution and callback delivery; they do not establish slow disk I/O.
The first 605 ms and the interval before platform preparation are not fully
subdivided by this probe.

### uBlock's data initialization

Three additional diagnostic launches captured uBlock's own startup log phases
and IndexedDB request-success events. Logging was enabled only in memory;
neither hidden settings nor filter data was changed.

| Phase | Run 1 | Run 2 | Run 3 |
| --- | ---: | ---: | ---: |
| Data startup → settings and public-suffix list ready | 186 ms | 378 ms | 347 ms |
| Compiled filter snapshot restoration | 291 ms | 350 ms | 120 ms |
| Network snapshot IndexedDB request → success | 221 ms | 277 ms | 60 ms |
| Network snapshot success → filtering engine restored | 69 ms | 73 ms | 60 ms |
| Engine restored → uBlock all-ready log | 6 ms | 6 ms | 5 ms |
| Entire observed data-startup sequence | 489 ms | 741 ms | 476 ms |

The snapshot's IndexedDB request interval includes renderer event scheduling,
not just disk access. The success-to-restored interval includes parsing,
rebuilding engine structures and remaining resource work; it is not exclusively
CPU time. Minor gaps and overlapping tasks mean the rows are not an exact
additive partition.

The separate CPU profile no longer has the former bulk extension-storage chunk
loop as a hot path. It still contains shell work and cache restoration
(`cachestorage.js`'s `gotOne` accounts for about 57 ms of sampled time).
It is a shared-renderer profile over the whole observation window, including
post-startup idle time, and must not be treated as a CPU-only startup timeline.

## Next opportunities

1. **Reduce extension module dependency waves.** Native transport removed file
   bodies from the broker, but each file still requires interception,
   authorization and CDP delivery. Background document loading remains near
   one second. Test bundling/preloading or a carefully scoped native fast path
   for already-authorized own-page resources, retaining frame and extension
   lifecycle rules. Any new fast path needs its own permission review.
2. **Reduce platform preparation before UI startup.** The measured 860 ms
   interval contains several native storage/setup awaits. Instrument their
   native execution separately from callback delivery, then batch or defer
   work not needed for the first view.
3. **Coalesce concurrent keyed settings reads.** The large whole-store read is
   gone, but independent settings requests still produce serial store loads.
   Several run in parallel from uBlock's perspective. Batching their keys may
   shorten the 186–378 ms settings phase without changing extension semantics.
4. **Investigate snapshot delivery before changing filter data.** The network
   snapshot request varies from 60 to 277 ms while the subsequent engine work
   is closer to 60–73 ms. Distinguish IndexedDB work from callback contention
   and evaluate earlier cache opening/read-ahead. The profile does not justify
   discarding filters or moving the protected-navigation readiness signal.

These are remaining candidates, not implemented improvements or promised gains.

## Validation

- 115 JavaScript runtime/Lite tests passed, including shared protocol policy,
  one-use grants, requesting-frame restrictions and native file descriptors
  without body data.
- 47 JVM tests passed, including binary byte preservation, security headers,
  missing-file behavior and exclusion of native directory/path metadata from CDP.
- Six Samsung instrumentation tests passed: all five engine regressions plus
  public binary asset loading, private-file denial, missing-file 404, correct PNG
  bytes/MIME and no asset-body data through the broker.
- Package/root/mobile type checks, lint, structural limits, package boundaries
  and whitespace checks passed.

The device tests use the separate dev package. The production-identity app is
restarted without profiling overrides afterward, and its installed APK is
checked against the local build by SHA-256. Raw traces and profiles are retained
locally under `artifacts/lite-startup-detail/` (ignored by Git).
