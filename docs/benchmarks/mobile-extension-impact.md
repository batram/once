# Mobile extension performance and implementation assessment

Implementation follow-up: [fixes, native validation and before/after measurements](mobile-extension-improvements.md). The results below preserve the original baseline.

Measured on 4 October 2026 against commit `517a24ba1e05be953ec2997573288505797cdd76`. The accompanying [evidence file](mobile-extension-impact.json) retains individual runs, compiler failures, versions, sample ranges, and summary calculations. Production code was not changed.

The clearest actionable findings are in Once's supplemental-filter implementation. On the physical iPhone, ordinary domain-anchored filters fail WebKit compilation, and clearing the filter list also fails. Large-list export occupies the main actor for hundreds of milliseconds. Android evaluates supplemental rules through a blocking JavaScript callback with a linear search on every request. These deserve attention before broadly reducing extension support.

The bundled iOS extensions add about 290 ms to the measured first-page initialization path, while subsequent loads of the controlled article add about 10 ms. The fixture does not show a sustained frame-pacing regression. Android results below must be interpreted within an emulator, not compared numerically with the physical iPhone.

## Scope and measurement method

- **iOS:** iPhi, physical iPhone 16 Pro Max, iOS 27.0.1; development-signed Release harness compiled with `-O`. Four fresh-process launches per extension configuration and four page loads per launch. Extension storage was initialized by a pilot before this matrix. All recorded thermal states were nominal and Low Power Mode was off.
- **Android:** Android 16, API 36, arm64 emulator on an Apple M4 Pro with macOS 26.6.2; GeckoView `155.0.20260903215306`, debug harness. Separate persistent Gecko profiles for each configuration. Four launches per configuration; round zero conditions each profile and is excluded from summary figures. Both Once's bridge and third-party extension assets are the real repository bundles.
- **Fixture:** 1,500 paragraphs, 400 style rules, one second to settle after navigation, then 90 animation frames with 50 DOM mutations and a forced layout read per frame. Android also requests 100 local resources concurrently, each 16 KiB, with caching disabled. Every successful batch transfers 1,638,400 bytes. The traffic intentionally does not match the supplemental rules, exercising their full search rather than short-circuiting at the first match.
- **Isolation:** separate benchmark application identifiers and containers. Neither Once's existing data nor its extension settings were modified. The iOS host is compiled unchanged. The Android engine is copied with only per-configuration profile selection and bundle-selection ablations; its initialization, engine options and built-in loading calls are retained. The benchmark reproduces the production requirement to open a session before waiting for the bridge's settings acknowledgement.

These are component measurements, not end-to-end Once launch times. iOS navigation uses `loadHTMLString` with an HTTPS base URL; Android loads an HTTP fixture through the emulator's host connection. Neither includes ordinary internet latency, third-party advertising, live YouTube playback, installed Violentmonkey scripts, Capacitor shell rendering, or full host watchdog and toolbar activity. No battery, thermal-soak, or physical Android measurements were made. Host activity and emulator scheduling were not tightly controlled; small Android differences should not be treated as regressions.

Each configuration is rotated and the order reversed in alternating rounds. The launch count is small. Ranges are retained rather than presenting a misleading startup p95 or claiming statistical significance. Page observations within one launch are correlated. Extension background traffic and automatic filter updates were not intercepted; especially early startup samples can include that work. The fixture itself contains no third-party requests.

## iOS extension measurements

Values below are medians in milliseconds. “First finished page” is host preparation plus surface creation plus the first native navigation completion; it excludes OS app-launch dispatch. “Later navigation” covers the three remaining loads per launch. All single-extension configurations still parse the other disabled extensions, just as the real host does.

| Configuration | Host preparation | First finished page | Later navigation |
| --- | ---: | ---: | ---: |
| Bare WKWebView | 0.6 | 97.8 | 26.7 |
| Host with all four disabled | 21.9 | 105.2 | 27.8 |
| uBlock Origin Lite only | 126.3 | 201.4 | 30.8 |
| Violentmonkey only, no scripts | 110.5 | 162.6 | 28.1 |
| SponsorBlock only, unmatched article | 104.1 | 152.6 | 27.3 |
| Dark Reader only | 106.0 | 167.9 | 32.8 |
| All four enabled | 288.6 | 387.7 | 37.1 |

All-enabled preparation ranged from 285.8 to 292.9 ms. The first-finished-page difference against bare WebKit is **289.9 ms**; the difference against a host with everything disabled is **282.5 ms**. Later navigation differs from bare WebKit by **10.4 ms**, about **39% of this small local baseline**, not 39% of an ordinary website's loading time.

The median per-page 95th-percentile animation-frame interval was 17 ms in every configuration. Of 1,424 measured frame intervals per configuration, 14 exceeded 25 ms in the bare case and 9 in the all-enabled case. That does not establish an improvement from extensions; it shows no clear sustained frame regression in this particular mutation fixture. Dark Reader was active: the result records its injected styles and the computed dark background. SponsorBlock's video-matching workload and userscript execution were absent.

### Why the iOS initialization cost occurs

[WebExtensionHost.prepare](../../apps/mobile/ios/App/App/WebExtensionHost.swift) loads bundles sequentially and explicitly calls `loadBackgroundContent()` for each enabled extension. Disabled bundles still create a `WKWebExtension`, a context and permission entries. The completed preparation task is cached, so normal subsequent navigation does not repeat this initialization.

Apple documents that [`loadBackgroundContent`](https://developer.apple.com/documentation/webkit/wkwebextensioncontext/loadbackgroundcontent%28completionhandler%3A%29) forces loading that would otherwise occur on demand. That establishes an optimization candidate, not proof that removing the call preserves content-script registration, filtering or recovery. Likewise, the measured total does not establish how much parallelizing initialization would save.

[The production plugin](../../apps/mobile/ios/App/App/AppDelegate.swift) warms extensions during settings application, before a browsing surface is necessarily opened. Its navigation methods also await preparation. Therefore some or all of this cost can overlap time spent in the story UI; it is not necessarily an additional 290 ms on every first article tap. Conversely, the work can consume resources even if the user never opens a webpage. The harness does not quantify that shell interaction.

## iOS supplemental filters fail native compilation

The benchmark calls the actual [IOSContentBlockerExporter](../../apps/mobile/ios/App/App/ExtensionSupport.swift) and the device's `WKContentRuleListStore`. Only Capacitor's `JSObject` alias is substituted in the standalone build.

| Input | Native result on iPhi |
| --- | --- |
| Empty list, exported as `[]` | Rejected: `Empty extension` |
| `||ads.example^` | Rejected: `Invalid or unsupported regular expression` |
| `ads.example` | Compiles |
| `\|https://ads.example/banner\|` | Compiles |
| `##.advert` | Compiles |

The domain-anchored exporter produces `^https?://(?:[^/]+\.)?ads\.example(?:[^A-Za-z0-9_.%-]|$)`. WebKit's content-rule regex dialect is narrower than JavaScript's. The native controls establish rejection of the complete exported pattern; they do not isolate every unsupported construct individually. [WebKit's format documentation](https://webkit.org/blog/3476/content-blockers-first-look/) explicitly describes the restricted syntax and parse errors for unsupported expressions.

The failure affects the **combined supplemental list**, not the separately hosted uBlock Origin Lite rules. In `compileAndInstallRules`, removal of the existing rule list occurs only after compilation succeeds. Thus an empty update throws before clearing an already installed list. This retention consequence follows directly from the production control flow; an end-to-end Once settings-toggle reproduction was not performed. Empty default settings also trigger the rejected-compilation path.

For synthetic `||never-match-N.example^` lists, export alone measured approximately **7–8 ms for 1,000 rules**, **65–67 ms for 10,000**, and **330 ms for 50,000**. The evidence contains three samples at each size and the exact values. The 50,000-rule JSON is about 6.23 MiB. **Compilation failed for these lists, so these are export timings, not successful compilation or filtering-throughput results.**

Production calls this synchronous exporter inside `Task { @MainActor in ... }`. At 60 Hz, 330 ms spans roughly 20 frame budgets. The measured conversion duration and the actor placement make this a concrete responsiveness risk, although the full Once UI's dropped frames were not measured. Stale generations are checked during installation, after export work; superseded downloads can therefore still incur conversion work. The current path also recompiles rather than looking up a content-hash-matched compiled list and attempts a network download before falling back to cached text.

## iOS supplemental userscript overhead

The production userscript shim injects each enabled wrapper into applicable frames, then performs URL matching in JavaScript. Android's bridge instead passes matches and globs to Gecko's content-script registration API. This is a real implementation difference, independent of Violentmonkey.

Using the actual iOS shim, with harmless bodies and deliberately unmatched URLs, three fresh-process launches per configuration produced:

| Unmatched wrappers | Registration time | Later navigation |
| --- | ---: | ---: |
| 0 | below 0.1 ms | 26.9 ms |
| 100 | 0.5 ms | 27.7 ms |
| 1,000 | 3.3 ms | 35.4 ms |

The 1,000-wrapper case adds about **8.5 ms** to later navigation, and every recorded page confirms that the script bodies did not run. One hundred unmatched wrappers had only a small effect here. This does not characterize expensive matching patterns, matching script bodies, storage calls, or iframe-heavy sites. It places unmatched-script prefiltering below the filter-export and Android-request-path work in the priorities for this workload.

## Android implementation and measurement interpretation

Android's [GeckoEngine](../../apps/mobile/android/app/src/main/java/com/zmarn/once/GeckoEngine.java) is process-owned and starts lazily when browsing or extension management requires it. Settings application alone does not start it. Built-ins are ensured concurrently and the readiness result is cached. Production also caches navigation readiness, avoiding catalog enumeration on later navigation. These are useful existing optimizations.

All non-bare Android configurations include Once's bridge. “Blocker” adds uBlock Origin, “vm” adds Violentmonkey, and “all” adds both. The 1,000- and 10,000-rule configurations include only the bridge plus synthetic supplemental lists. They do not measure adding those lists to uBlock's own indexed filtering engine.

Medians from three retained fresh-process launches per configuration are below. Each launch contributes three later-page traffic batches to the final column; its first batch is excluded to separate initial compilation/warming from later requests. Readiness ends at the bridge acknowledgement (or session setup for bare Gecko), before the requested page load. PSS includes all five enumerated benchmark processes in each snapshot.

| Configuration | Ready before page load | Process-group PSS | Later 100-request batch |
| --- | ---: | ---: | ---: |
| Bare Gecko | 2,130 ms | 532.6 MiB | 574 ms |
| Once bridge, no supplemental rules | 4,333 ms | 567.4 MiB | 693 ms |
| Bridge and uBlock Origin | 4,038 ms | 660.5 MiB | 734 ms |
| Bridge and Violentmonkey | 5,504 ms | 547.9 MiB | 738 ms |
| All default bundles | 4,776 ms | 697.5 MiB | 717 ms |
| Bridge and 1,000 supplemental rules | 5,197 ms | 543.4 MiB | 662 ms |
| Bridge and 10,000 supplemental rules | 5,100 ms | 642.0 MiB | 2,098 ms |

The **10,000-rule workload is 3.03 times the empty-bridge median**, adding about **1.41 seconds per 100-request batch**. Its nine later-page batches ranged from 1,843 to 2,379 ms; the empty bridge ranged from 500 to 976 ms. The first batch in each retained 10,000-rule launch took 3,921–4,241 ms. This is a repeatable scaling signal in this environment. The 1,000-rule result does not establish a slowdown at that size.

The default bundle group used about **165 MiB more PSS than bare Gecko** and **130 MiB more than the bridge-only configuration** at the measured point. uBlock accounts for most of the observed increment. Do not interpret the lower VM or 1,000-rule snapshot relative to bridge-only as a memory optimization: collection, JIT and shared mappings make these short snapshots nonmonotonic. Physical-device measurements and repeated idle/peak snapshots are needed for a memory budget.

All-default readiness ranged from 4,159 to 4,833 ms; empty-bridge readiness ranged from 3,340 to 4,832 ms. Thus this run does not isolate a reliable incremental startup penalty for adding both third-party bundles above the mandatory bridge. The large bare-to-bridge difference includes extension-system startup, registration and the native settings handshake, not just two `.some()` calls.

Default-bundle request times overlap the controls substantially, and this test provides no strong claim of a universal throughput regression from the bundled extensions. Emulator frame-pacing p95s commonly ranged from 33 to 67 ms even in the bare configuration, unlike the physical iPhone; they are unsuitable for predicting physical Android smoothness.

The bridge's [request callback](../../apps/mobile/extensions/once-surface/background.js) is registered with `blocking` for `<all_urls>` even with empty arrays. For a nonmatching request, its cost grows with every exception plus every blocking regex: approximately O(requests × rules), in addition to engine-to-extension dispatch. The list-size comparison includes this production callback and settings handshake; it is not a Node-only regex microbenchmark. The bare-to-bridge comparison includes all bridge activity, so it cannot assign the whole difference to the empty callback alone.

Settings preparation downloads lists, parses them, registers scripts and acknowledges the native host before its requested navigation proceeds. Production bounds this wait at 15 seconds, but the JavaScript download has no explicit abort or per-fetch deadline and the serial settings queue can remain occupied afterward. A failed application is logged and acknowledged. Therefore “settings acknowledged” is not equivalent to “every list applied successfully.” These are code-review findings; the fixture uses a fast local server and successful downloads.

## Memory lifecycle and packaged size

Android memory figures sum PSS across the benchmark main process and every process with its application-name prefix, including Gecko children. A single `dumpsys meminfo <package>` only returned the parent in this environment and was rejected as an incomplete metric. Snapshots are taken after the fourth page and are not peak memory, heap-only usage, idle-after-GC usage, or physical-phone budgets. PSS shares mapped pages proportionally and varies with other processes.

The real Android app additionally retains its Capacitor WebView. The harness omits that shell, its native management UI, and production health checks. The production watchdog schedules checks every second after navigation, sends normal health requests about every five seconds, and pauses while hidden. Media updates are event-driven and throttled when enabled. Those features can contribute CPU/wakeups, but no energy figure is assigned to them here.

Android extension pages can retain up to 12 sessions; hidden pages and the hidden reading session have memory-pressure cleanup. Closing the reading surface does not destroy the process-owned Gecko engine. iOS keeps one extension page at a time, but detaching the reading view does not unload the host's extension contexts. Apple only permits nonpersistent extension backgrounds on iOS; explicitly waking them during preparation must not be mistaken for pinning all background pages indefinitely. The adapted Violentmonkey background reconstructs its value bookkeeping after waking rather than rerunning content scripts. Suspension, long idle periods, memory warnings, and popup accumulation remain profiling targets.

Uncompressed files in the current vendor tree total **51.54 MiB for the four iOS bundles** and **16.75 MiB for Android's uBlock and Violentmonkey**, excluding Once's small bridge. uBlock Origin Lite alone contributes **42.12 MiB**, about 82% of the iOS extension assets. These are installed-resource inputs, not compressed App Store/APK download deltas, peak RAM, or active ruleset size. See the JSON for byte counts and file counts.

## Priorities supported by the evidence

1. **Fix iOS supplemental-filter correctness first.** Clear installed rules directly for an empty effective list. Translate supported ABP semantics into WebKit-compatible rules and add native compilation controls; passing a JavaScript regex test is insufficient. Preserve prior rules on actual fetch/compile failure while distinguishing deliberate removal.
2. **Remove avoidable work from Android's request path.** Register the blocking callback only when effective network rules exist. Replace the linear scan with an indexed matcher or a semantically compatible compiled/declarative path. Keep exception ordering and the documented portable subset intact. Measure the empty-list ablation separately before attributing its savings.
3. **Move iOS export off the main actor and avoid redundant applications.** Check the generation before expensive conversion, cache by content hash, reuse compiled rules, and do not redownload/recompile solely because an unrelated userscript changes. Recheck the generation before committing results.
4. **Experiment with iOS background initialization policy.** Compare eager, selective and on-demand loading with first-document filtering and userscript recovery tests. The approximately 270 ms difference in preparation between enabled and disabled hosts is the observed opportunity envelope, not a promised saving. Preserve early blocker setup.
5. **Validate on a physical Android phone and realistic content before changing defaults.** Include low-memory devices, ad-heavy pages, YouTube with SponsorBlock, dynamic Dark Reader themes, representative userscripts, background audio and a long idle/energy test. Measure transferred bytes and avoided third-party work together with overhead: this fixture cannot answer whether blocking improves a real site's net load time or battery usage.

## Reproduction and validation

The isolated apps use `com.zmarn.once.extensionbenchmark`; do not substitute the production application identifier. The builders consume already-fetched vendor bundles. Generated projects are placed under `/tmp` by default, and raw runtime output goes under `artifacts/extension-benchmark`.

For iOS, run `node tests/e2e/mobile/build-extension-benchmark-ios.js`, build `/tmp/once-extension-benchmark-ios/Bench.xcodeproj` with `xcodebuild` for a physical device, install its Release `Bench.app` with `devicectl`, then run `node tests/e2e/mobile/run-extension-benchmark-ios.js <device-id> 4`. Signing currently uses the repository's development team; adapt it when reproducing elsewhere. The standard matrix takes several minutes. `ONCE_BENCH_MODES=scripts0,scripts100,scripts1000` selects the userscript matrix; use three rounds. Launch the same app with the argument `rules` and copy `Documents/benchmark.json` as `ios-rules.json` for the compiler controls.

For Android, run `node tests/e2e/mobile/build-extension-benchmark-android.js`, build `/tmp/once-extension-benchmark-android` using the repository Gradle wrapper, install `app/build/outputs/apk/debug/app-debug.apk`, then run `node tests/e2e/mobile/run-extension-benchmark-android.js <emulator-serial> 4`. The runner serves localhost port 18765, reached through `10.0.2.2`; it currently targets an arm64 emulator. The implementation follow-up adds `ONCE_BENCH_BASE=http://127.0.0.1:18765` with an ADB reverse tunnel for physical arm64 Android; use a matching ABI when testing other devices. Match production's asset ignore pattern: the default Android pattern excludes extension `_locales` directories and causes invalid-extension errors.

Regenerate the evidence with `node scripts/summarize-mobile-extension-benchmark.js`. The checked-in JSON preserves each included run so summary definitions and outliers can be reviewed. Android round zero and all four page samples remain in the file even where the summary excludes conditioning or first-page samples.

Validation completed:

- 65 recorded configuration launches and 260 fixture page loads, including the seven Android conditioning launches retained in the raw evidence. The reported Android summaries exclude those conditioning launches.
- Native iOS Release and Android debug harness builds succeeded. The final iOS source also restores normal screen-sleep behavior after completing a run.
- All 28 selected regression tests passed: portable filters, iOS packaging and Violentmonkey adaptation, Gecko bridge/lifecycle, media bridge and extension settings. The initial sandboxed test-server attempt could not bind localhost; the same tests passed with localhost access.
- ESLint passed for all added JavaScript harness and summary files.
- Evidence validation checked complete page sets, expected Dark Reader state, inert unmatched userscripts, enabled Android extension catalogs and complete traffic byte counts. Every Android memory snapshot included all enumerated benchmark processes.

The passing JavaScript tests do not supersede the native iOS compilation failures. Those failures are preserved as findings, not hidden or converted into successful performance samples. No product layout, production code, real Once data, or user extension settings were changed.

At the time of this investigation, the extension compatibility document described iOS as only the small shim/content-blocker path and later said iOS could not execute Firefox WebExtensions, despite the host loading four adapted bundles through `WKWebExtensionController`. The implementation follow-up corrects that documentation.
