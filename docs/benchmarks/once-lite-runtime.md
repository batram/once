# Once Lite runtime hardening and performance — 2026-10-20

This follow-up fixes the eight findings against `4e094a19`. Raw measurements are
in [once-lite-runtime.json](once-lite-runtime.json). These measurements describe
one Android emulator and a host-JVM microbenchmark; they are not physical-device
latency, peak-memory, or battery guarantees.

## Correctness and security

| Finding | Change | Regression coverage |
| --- | --- | --- |
| Deferred injection bypassed host grants | Authorize the pending document, bind the injection to its request identity, and recheck authority before preparing it | A storage-only extension is refused; a queued injection loses a revoked activeTab grant |
| Java regex backtracking | Use RE2/J 1.8 for rule compilation and cache restoration; remove URL truncation; invalidate old compiled caches | Former stack-overflow and timeout patterns, plus a match beyond 4 KB |
| Dead broker WebView reused | Destroy and replace the broker WebView and target, clear native state, and rebind tabs | Terminate the actual renderer; verify the catalogue and extension worlds in a new tab |
| Released Fetch IDs stranded later stages | Give each pause a generation and reject stale generations | Release request stage, create response stage with the same ID, accept only the new generation |
| Extension-page reload kept old reply proxies | Use monotonically increasing document-context IDs and retire old contexts/listeners | Reload uBlock's options page and call storage APIs again |
| Detached iframe contexts leaked | Retire a detached frame's worlds and descendants before deleting mappings | Replay detach followed by context-destroyed events |
| Pending same-origin document lent its allow rule | Require a document URL match instead of an origin match | Pending `/allowed` does not authorize requests referring to committed `/untrusted` |
| Synchronous-answer queues were unbounded | Bound total bodies and estimated UTF-16 bytes, expire answers, scope them to target/frame, and clear on lifecycle changes | 10,000 duplicate-URL writes, byte limits, expiry, and cross-frame/target isolation |

The synchronous-answer budgets are 256 total entries, 16 MiB of estimated string
storage, and 30 seconds of age. Expiry is checked on cache operations; navigation
and target/frame removal also discard answers. The limit applies to duplicate
URLs, not just the number of distinct URL keys.

## CSP response transport on Android

The old path moved the complete response body from CDP into Java, into the broker
renderer, back into Java, and finally into CDP. `Fetch.fulfillWithBody` now keeps
an unchanged document body on the native CDP path. The broker supplies the status
and revised headers; its renderer never receives or serializes the body.

Environment: Pixel 9 emulator, Android 16/API 36, WebView 155.0.8059.43. The test
alternates the former algorithm and the native algorithm on the same local HTML
fixtures, warms both paths, and collects three samples per path and payload size in each of two runs (six per path/size in the combined results).
The former algorithm is installed only by the instrumentation test; there is no
production switch. Timings below are medians from Navigation Timing, not time
spent waiting for instrumentation callbacks.

| HTML payload | Former path | Native path | Body characters crossing broker IPC, former → native |
| --- | ---: | ---: | ---: |
| 64 KiB | 456 ms | 398.5 ms | 174,944 → 0 |
| 512 KiB | 910 ms | 720 ms | 1,398,288 → 0 |
| 2 MiB | 1,456 ms | 777 ms | 5,592,592 → 0 |

The combined 2 MiB median improved about 47%. Smaller-page results vary:
the engine-suite run's 512 KiB median was slower on the native path, although
the combined median improved about 21%. Startup/list activity, scheduling, and
garbage collection remain sources of variance; six samples do not establish
p95 latency or a universal speedup. The elimination of body traffic through the
broker is deterministic and asserted for every native-path sample.

CDP still buffers the whole response. This change removes a major duplicate
transfer and allocation path, but does not implement streaming or bound the peak
memory of arbitrarily large CSP documents. Those remain release-qualification
work on physical devices, particularly low-memory devices.

## Tier 2 matching on the host JVM

Environment: macOS arm64, Android Studio JBR/OpenJDK 21.0.10. The workload uses
the shipped uBlock filters, EasyList, and EasyPrivacy rulesets, 50 prebuilt script
requests per URL size, 1,000 warmup evaluations, then five measured rounds. Each
round evaluates 5,000 short URLs or 200 long URLs. Allocation is measured by the
JVM's per-thread allocation counter; it is temporary allocation per evaluation,
not retained or peak process memory.

The deeper allocation probe found `String.matches()` recompiling a numeric-host
regex inside repeated third-party checks. Site classification is now computed
once per request with a character scan. URL trigrams are also computed once and
shared by all ruleset parts, and native network events use direct session lookup
instead of scanning all tab attachments.

| Workload | Reviewed commit | RE2/J before request-path optimizations | Fixed |
| --- | ---: | ---: | ---: |
| Roughly 100-character URL, median time | 62.25 µs | 84.83 µs | 49.57 µs |
| Same, allocated bytes/evaluation | 721,072 | 649,504 | 16,608 |
| Roughly 32 KB URL, median time | 905.18 µs | 6,057.14 µs | 5,711.37 µs |
| Same, allocated bytes/evaluation | 2,308,864 | 1,989,136 | 782,112 |

Against the reviewed commit, short-URL time improved about 20% and allocation
fell about 98%. Long-URL time is higher because the reviewed code truncated
regex input to 4 KB, changing rule semantics; the fixed engine checks the whole
URL. This is an intentional correctness/security tradeoff, not an equivalent
workload speedup. The fixed matcher accepts 112,542 rules versus 112,543 in the
reviewed commit; unsupported regex syntax is now judged by RE2/J itself.

Reproduce the current host measurement after building the Lite JVM tests:

```sh
node scripts/benchmark-lite-dnr.js
```

Set `JAVA_HOME` to the Android build JDK. An optional first argument selects
another checkout's sources. The harness and rulesets remain those of this
checkout. The intermediate RE2/J baseline in the JSON retains the old repeated
request computations, isolating their cost from the regex-engine change.

## Watchdog latency and validation

When the watchdog releases a request stage, it now specifies
`interceptResponse: false`. A synchronous XHR keeps the shared renderer blocked
until its response arrives, so intercepting it again previously incurred a second
watchdog cycle. Pause generations remain necessary for other later-stage events
and late commands.

The native probe records the synchronous XHR's own `performance.now()` duration
separately from the whole document's load time. Cold extension startup and lost
`evaluateJavascript` callbacks can otherwise dominate the test harness's wall
clock. The paired probe measured the old two-stage release behavior at 10,295 ms
inside the synchronous XHR and the fixed behavior at 5,423 ms (about 47% less).
Whole-document times were 18,544 ms and 13,297 ms respectively, including cold
startup. Each mode has one measured run. The baseline changed only the watchdog's
response-interception behavior; that temporary source change was restored after
the run. See the raw JSON for both measurements.

Validation includes the mobile and shared-runtime unit suites, 44 Lite JVM tests,
all five Tier 1 engine tests and the transport benchmark, and the Tier 2 instrumentation suite.
Renderer termination, reloaded extension-page API calls, reconnection, filtering,
userscripts, and persistence are exercised on the emulator. Type checks, targeted
ESLint, structural limits, boundary checks, and whitespace checks also pass.
The full Appium acceptance suite and a physical-device/WebView-version matrix
were not run as part of this follow-up.
