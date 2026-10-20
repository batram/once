# Once Lite on Samsung: a615e626 review and startup follow-up

Measured on 20 October 2026. Aggregate measurements and individual CSP samples
are in [once-lite-samsung.json](once-lite-samsung.json).

The installed baseline was `a615e626011bd2884b51b03b968481b268903a70`.
The follow-up makes saved stories and settings usable while extensions start,
batches native point reads, and yields between large extension-storage reads.
It retains the initial navigation barrier for filters and userscripts.

## Device and methodology

- Samsung Galaxy S20 FE, SM-G780G, Android 13.
- Android System WebView 155.0.8059.43; Lite Tier 1 with DevTools available.
- Once Lite 0.4.0, production package identity `com.zmarn.once.lite`, debug APK.
- Existing configured profile, five source entries, both bundled extensions enabled.
- Four baseline and five final process-cold launches. Data, cookies and caches
  were retained; no app-data clear or clean-install migration was involved.
- Startup measurements use the shell's performance clock, calibrated against
  the host at the midpoint of a CDP round trip. Content readiness is observed
  through DOM changes, not an optical display measurement.
- Source policy remains cache-first. A source refresh during the final series
  changed the resulting list from 109 to 110 rows and contributed to slow
  samples. These are real configured-profile launches, not a frozen dataset.

## Startup

Times are milliseconds from the launch request; ranges are observed min–max.

| Milestone | a615e626 median (range) | Follow-up median (range) |
| --- | ---: | ---: |
| Android activity shown | 1,188.5 (1,143–1,333) | 1,173 (1,153–1,256) |
| Five source configurations populated | 5,220.7 (4,905.3–5,561.6) | 2,457.7 (2,259.5–2,513.6) |
| First story rows | 5,475.9 (5,109–5,799.8) | 2,853 (2,713.9–4,504.7) |
| Complete current story list | 5,581.3 (5,213.2–5,955) | 2,951.6 (2,792.4–4,964.3) |
| Initial extension hand-off complete | Not separately marked | 4,658.6 (4,498.4–5,216.2) |

First stories improve about 48%, configuration availability about 53%, and the
complete list about 47%. The activity itself is essentially unchanged.
The initial website still waits for extensions: the improvement does not
declare browser protection ready when only the shell is ready.

The old sequence awaited `bindExtensionSettings()` before mounting the UI.
The new sequence mounts the UI concurrently and gates `open`/`navigate` until
the initial application and any superseding settings application settle.
Queued navigations keep their tab identity, current visibility and bounds;
closing or superseding an operation cancels its queued work. A stale native
acknowledgement cannot reinstall an older userscript document.

The initial status pill is now owned by source progress, rather than being
overwritten with “Ready” before the first rows arrive.

## Deeper findings

### Native database bridge

The baseline diagnostic launch issued 286 `getMany` calls and 238
`iteratorOpen` calls after the instrumentation attached. Most `getMany` calls
contained one key. PouchDB's keyed `allDocs` opens one exact-key iterator per
document, even though the native implementation already materializes these
as point snapshots.

The adapter now groups those point snapshots into at most 128 keys per bridge
request. It flushes queued snapshots before a subsequent write, close or other
operation, preserving snapshot-at-creation ordering. Follow-up body reads are
bounded to 128 keys as well.

Observed native database calls fell from a median 541.5 to 90, about 83%.
The final diagnostic launch had nine iterator opens, including remaining
range iterators. These are bridge counts, not SQL query counts, and the
observation windows include differing background source activity. Bridge-call
durations include queueing; summing them would not measure wall-clock time.

Regression tests exercise same-turn snapshot/write ordering, missing keys,
zero limits, keys-only iterators, failed batches, large keyed reads, deletion,
revision branches, replication, 3.6 MB attachments, compaction and reopen.

### Extension startup and shared renderer work

A CPU profile of the installed baseline attributed about 1.31 seconds of
sampled native-call time to the synchronous `readChunks` loop, with additional
JavaScript time in that loop. It also showed compiled uBlock filter loading.
Profiles taken through different WebView targets contain shared renderer
work; they must not be added together as independent CPU usage.

Large store reads now use 256 KiB chunks and yield between chunks, using
`scheduler.yield()` where present and a timer otherwise. The native read token
continues to refer to the same opened snapshot. This gives shell rendering,
input and broker replies opportunities to run during a large read.

Unchanged uBlock list selections no longer trigger `reloadAllFilters`.
Readiness is still checked through uBlock's own dashboard response.
A persisted pending marker forces a retry when a previous selection change
saved its selection but did not finish rebuilding filters; a settings cache
hit must not silently accept that interrupted state.

These changes do not isolate the broker from the page renderer or eliminate
initial filter hydration and JSON parsing.

## Website loading

Four rounds were collected per build and extension condition. The first round
was treated as warmup; the table contains medians of three repeat samples.
Timings are Navigation Timing `loadEventEnd`, not address-bar-to-screen time.
Pages were validated using response status and title. Normal caches and
cookies were retained. The website series preceded the final startup-only
storage-yield refinement.

| Website | a615e626, disabled | a615e626, both enabled | Follow-up, disabled | Follow-up, both enabled |
| --- | ---: | ---: | ---: | ---: |
| Hacker News | 288 ms | 452 ms | 277 ms | 407 ms |
| Wikipedia, Web browser | 271 ms | 468 ms | 249 ms | 411 ms |
| BBC News | 1,613 ms | 442 ms | 1,646 ms | 1,621 ms |

The small changes on Hacker News and Wikipedia are not a controlled proof of
a new steady-state request-path speedup. Most follow-up changes target startup.
Both extensions still add roughly 130–160 ms on those simple repeat loads.
BBC varies strongly with the requests that load or are blocked; the reversal
of its medians is a warning against interpreting this small sample as a stable
improvement or regression. Ranges and FCP measurements are in the JSON.

The disabled baseline still includes Lite's bridge and broker. It is not bare
Android WebView or Chrome.

## Physical-device validation of a615e626

The commit's native CSP-body transport was tested against its former algorithm
on the same phone and fixture. The former algorithm is temporarily substituted
only inside the instrumentation test. Two paired runs contributed six samples
per algorithm and size, with both paths warmed before measurement.

| HTML body | Former transport median | Native transport median | Change |
| --- | ---: | ---: | ---: |
| 64 KiB | 177 ms | 170.5 ms | About 4% faster |
| 512 KiB | 315 ms | 245 ms | About 22% faster |
| 2 MiB | 694.5 ms | 473 ms | About 32% faster |

For every native-path sample, body characters crossing broker IPC were zero.
The former path transferred 5,592,592 body characters for each 2 MiB sample.
CDP still buffers the body; these results do not establish a peak-memory bound.

Review covered the new pause-generation checks, native response fulfillment,
frame/context retirement, broker recreation, synchronous-answer scoping and
RE2/J changes. No new blocking regression was identified in the reviewed paths.
The device suite passed renderer termination/recovery, dropped-connection
recovery, extension-page reload/API use, synchronous-XHR recovery, filtering,
cosmetic hiding, popup operation and persisted state after engine restart.

The synchronous-XHR probe still measured 5,427 ms and 5,506 ms in the two
physical engine runs. A page can block the shared renderer until the watchdog
releases its request. Shortening that watchdog changes filtering/fail-open
behavior, so this follow-up does not tune it merely to improve latency.

## Validation and remaining coverage

- 355 JavaScript tests across mobile and the shared extension runtime passed.
- All 44 Lite JVM tests passed.
- The final Samsung instrumentation run passed all six tests: five engine
  tests and the paired CSP transport benchmark.
- Root and mobile type checks, targeted ESLint, structural limits, package
  boundary checks and whitespace checks passed.
- Live phone inspection covered Stories and Story Sources in light and dark
  themes at 360×800 CSS pixels (1080×2400 screenshot pixels), with no document
  horizontal overflow.
- An artificial 2.5-second delay in native settings acknowledgements verified
  that stories remained usable and native `open` was sent only after the
  extension-ready mark. Switching back to Stories during the wait was
  preserved. This injected delay is excluded from performance measurements.
- Extension enablement and the original theme were restored. Final delivery
  restarts the app to discard all injected profiling hooks.

This is one physical device and WebView version. Tier 2 on physical devices,
peak-memory/battery measurements, heavy custom userscripts and the full Appium
acceptance matrix remain unmeasured here.

Native engine tests remain emulator-only by default. Physical runs require
`-e allowPhysicalDevice true` and are still restricted to the separate
`com.zmarn.once.lite.dev` package.

Full local evidence is retained under
`artifacts/lite-a615e626-review/`: startup observations, native-call counts,
Navigation Timing records, CPU profiles, instrumentation output, screenshots,
geometry and the delayed-navigation probe. The directory is ignored by Git;
the aggregate JSON beside this report preserves the portable results.
