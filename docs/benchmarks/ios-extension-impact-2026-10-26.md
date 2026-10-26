# iOS Firefox extension performance investigation — 2026-10-26

This investigation measures the current iOS extension implementation at revision `49615306`, including the recently added Firefox XPI installer. The measurements use a physical iPhone 16 Pro Max running iOS 27.0.1 and an isolated Release app compiled with Swift `-O` under Xcode 26.6. The production host, installer, archive reader and filtering implementations are copied into the harness without changes. Once's application and extension data are untouched.

The largest measured costs are initial-use latency, CPU, and **transient physical memory**, especially with uBlock Origin Lite. All bundles produce a 488 ms first-page component sum versus 122 ms bare, and the app process peaks near 379 MiB of physical footprint versus 18 MiB bare. After idle the app footprint is much smaller, about 34 MiB. Ordinary-page AMO shim overhead is small; installed-package initialization and very large supplemental lists have separate scaling costs. These results support targeted startup and peak-memory work, with total WebKit process-group and real-site profiling still needed.

The [machine-readable evidence](ios-extension-impact-2026-10-26.json) retains conditioning runs, individual page results, per-launch summaries, enabled extension catalogs, native errors, thermal state, source hashes and bundle sizes. This is a new experiment, not a numerically comparable continuation of the [October 4 HTML-string benchmark](mobile-extension-impact.md) or its [implementation follow-up](mobile-extension-improvements.md).

## Bundled extension measurements

Medians across five retained launches per configuration. All time columns are milliseconds. App CPU is summed user/system CPU for the app process over four pages; it excludes WebKit child processes.

| Configuration | Preparation | First-page component sum | Later navigation | Later 100-request batch | App CPU ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| Bare WebKit | 0.5 | 121.8 | 8.9 | 93.0 | 798.5 |
| AMO shim only | 1.1 | 125.9 | 9.5 | 92.0 | 800.1 |
| Host, all bundles disabled | 16.2 | 130.9 | 9.4 | 92.0 | 812.9 |
| uBlock Origin Lite only | 138.2 | 296.0 | 10.6 | 97.0 | 3919.4 |
| Violentmonkey only | 46.3 | 167.2 | 10.0 | 97.0 | 921.8 |
| SponsorBlock only | 48.2 | 163.0 | 9.7 | 96.0 | 927.6 |
| Dark Reader only | 50.1 | 176.2 | 10.6 | 97.0 | 943.5 |
| All four bundles | 179.6 | 487.5 | 11.9 | 99.0 | 4222.4 |

All bundles add 365.7 ms to the difference of first-page medians, approximately 4.0 times the bare component sum. The same-round additional time is 361.5 ms at the median, ranging from 313.5 to 415.4 ms across five pairs. All-bundle first-page sums range from 432.6 to 537.2 ms; bare ranges from 119.1 to 126.1 ms. This is a clear initial-use cost in this harness. It is not a measurement of a 366 ms regression from the recent installer commits: it includes all bundled extension activity and existing host support.

Later navigation adds a paired median of 2.91 ms with all bundles (range 2.80–3.04 ms). The 99 ms request-batch median is close to the 93 ms bare result; paired differences range from 2 to 8 ms. The experiment does not include blocked traffic and therefore cannot calculate a net browsing benefit or loss on real websites.

Every configuration's median per-launch frame p95 is 17 ms, and median synchronous mutation/layout work is 4 ms. Across 1,780 measured intervals per configuration, intervals over 25 ms occur 13 times with all bundles and 16 times bare; the other configurations range from 13 to 19. This is a roughly 60 Hz harness with timer quantization, not proof of 120 Hz smoothness, scroll responsiveness or absence of occasional long frames.

The ordinary-page AMO-shim increment is small: paired later-navigation overhead is 0.54 ms (0.38–0.72 ms); the first-page difference is 4.18 ms at the median but ranges from −0.12 to 23.91 ms. Its large bundle is an avoidable source of parse work, but this evidence does not support calling it the principal performance problem. An AMO page with its active observers and native calls is a different workload.

The all-disabled host still takes 16.2 ms to prepare because contexts are constructed before enabled-state checks. First catalog calls across the main matrix are on the order of 8–12 ms, including icon rendering; cached calls are around 0.16–0.20 ms. Cached `prepare()` calls are below meaningful millisecond resolution. Repeated catalog enumeration is not the main startup cost at four entries.

App-process CPU over the full four-page run is 4,222 ms for all bundles, 3,919 ms for uBlock Lite alone, and 799 ms bare. These include the in-app fixture server, native WebKit work, and the catalog probes. They exclude WebContent, extension-background and networking-process CPU, and do not measure main-thread stalls or energy. The extra work continues beyond the `prepare()` interval; preparation time alone substantially understates the cost observed during initial browsing.

## Memory and lifetime

The main matrix's app RSS increases from 88.8 MiB bare to 389.3 MiB with uBlock Lite and 394.5 MiB with all bundles. **That does not establish a 300 MiB retained private-memory penalty.** A separate lifecycle experiment reads both Mach resident size and `TASK_VM_INFO.phys_footprint`, the OS-charged app physical footprint.

One diagnostic launch per configuration, all values in MiB:

| Configuration | RSS after workload | Footprint after workload | Footprint after 35 s idle | Footprint 15 s after surface detach | Footprint 15 s after context unload |
| --- | ---: | ---: | ---: | ---: | ---: |
| Bare WebKit | 89.2 | 17.7 | 17.4 | 16.3 | 14.8 |
| uBlock Lite | 390.2 | 31.8 | 29.8 | 27.4 | 24.8 |
| All bundles | 395.3 | 50.0 | 33.7 | 37.4 | 22.3 |

After idle, the app-footprint increment is 12.5 MiB for uBlock Lite and 16.3 MiB for all bundles relative to the bare diagnostic. The much larger RSS increase must not be assigned directly to private allocations. These are sparse checkpoints from one run each; allocator state and asynchronous cleanup make the post-detach/unload numbers nonmonotonic. They do not prove a leak, measure process-group memory, or establish a device memory budget.

The app consumed about 26 ms of CPU during the bare idle interval, 33 ms with uBlock Lite, and 47 ms with all bundles. This does not indicate a busy app-process loop in this short idle workload. It says nothing about CPU in extension backgrounds or page processes, longer periodic work, or battery consumption.

The OS lifetime-peak counter exposes a cost that the end-of-work snapshots miss. Two additional fresh-process launches per configuration read `TASK_VM_INFO.ledger_phys_footprint_peak` after the four-page workload:

| Configuration | Median peak app footprint MiB | Range MiB | Post-workload app footprint MiB |
| --- | ---: | ---: | ---: |
| Bare WebKit | 18.0 | 17.9–18.1 | 18.0 |
| uBlock Lite | 366.7 | 362.0–371.4 | 32.0 |
| All bundles | 379.4 | 378.9–379.8 | 50.6 |

Thus all bundles add about **361 MiB of peak app footprint**, despite retaining far less afterward. The peak counter is cumulative from process creation, not a sampled maximum that might miss a short spike. In both all-bundle runs it was only 69–70 MiB after surface construction, then reached 379 MiB during the four-page workload. The expensive work extends beyond `prepare()`. This is a real transient memory-pressure concern; the measurements do not identify the precise allocating stack, prove a leak, or establish a jetsam threshold on another device. The full app and WebKit child processes would add their own memory usage.

The production host retains its contexts when a browsing surface is detached. Closing a tab is therefore not equivalent to disabling extensions. WebKit may unload nonpersistent background pages independently; [Apple requires nonpersistent extension backgrounds on iOS](https://developer.apple.com/documentation/safariservices/optimizing-your-web-extension-for-safari). The manual context-unload stage is diagnostic, not current app behavior on every tab close.

All these memory and CPU counters describe the UI/app process. [WebKit uses separate WebContent and networking processes](https://docs.webkit.org/Getting%20Started/Introduction.html); extension content and background work can live outside the app process. A complete budget needs correctly attributed child-process footprint, full Once shell/reader state, multiple tabs and memory-pressure testing. Adding raw RSS values across processes would double-count shared mappings.

## Installed package and supplemental script scaling

All four bundles are disabled for the installed-package matrix. Packages are minimal, have no background page or icons, and either do not match the fixture or increment a DOM counter exactly once. Three retained launches per mode follow one conditioning launch. Package creation and catalog seeding are excluded; subsequent runs reuse the same files. This measures already-installed startup overhead, not installation or realistic add-on bodies.

| Installed package configuration | Preparation ms | First-page component sum ms | Later navigation ms | Cached catalog call ms |
| --- | ---: | ---: | ---: | ---: |
| No installed packages | 15.66 | 132.75 | 9.60 | 0.16 |
| 10 enabled, unmatched | 56.09 | 180.41 | 10.34 | 0.28 |
| 50 enabled, unmatched | 180.16 | 301.73 | 12.81 | 0.71 |
| 50 disabled | 62.39 | 187.36 | 9.51 | 0.72 |
| 10 enabled, matching trivial script | 55.11 | 179.41 | 10.57 | 0.27 |

Fifty enabled but unmatched packages add a paired median of **164.5 ms** to preparation (range 162.9–165.5 ms) and 3.34 ms to later navigation. Fifty disabled packages still add **46.7 ms** to preparation (44.6–47.0 ms), while later navigation is effectively unchanged. The current host's serial parsing/context setup is a measurable scaling cost even when packages do not run content scripts. Minimal matching bodies add little in this fixture; that does not estimate arbitrary installed extension CPU or DOM work.

Cached catalog enumeration grows from 0.165 ms with no installed entries to 0.707 ms with 50 enabled entries. First calls are 7.9–9.1 ms across these configurations, including the bundled icons. Catalog enumeration is measurable but remains much smaller than package preparation here. Post-workload app footprints remain around 20–21 MiB; this excludes the isolated content worlds in WebKit child processes.

The supplemental wrapper matrix has no extension controller or AMO shim. All wrapper URLs deliberately fail to match, and every page verifies the bodies did not execute:

| Unmatched wrappers | Registration ms | First-page component sum ms | Later navigation ms |
| --- | ---: | ---: | ---: |
| 0 | 0.00 | 123.96 | 9.02 |
| 100 | 0.43 | 127.01 | 9.45 |
| 1,000 | 3.05 | 159.98 | 12.31 |

At 1,000 wrappers, the paired first-page increment is 36.0 ms and later-navigation increment is 3.24 ms (3.15–3.32 ms). At 100 wrappers, later-navigation overhead is about 0.42 ms. This supports URL prefiltering as a possible improvement at large script counts, but does not prioritize it above the measured extension initialization costs for normal small collections. Matching script bodies, complex regular expressions and many subframes can cost substantially more than these inert wrappers.

## Declarative rules and supplemental filter preparation

A separate minimal installed extension has no background page or content script, and declares 0, 1,000, 10,000 or 50,000 simple static DNR rules. All four bundles remain disabled. One rule blocks a dedicated loopback probe; the remaining rules never match. Every measured nonzero-rule page confirms the probe is blocked while the normal 100-response batch still transfers all bytes. This proves rules are active by the post-workload probe, not necessarily before the first document request.

Three retained launches per mode, after one conditioning launch:

| Declared DNR rules | Preparation ms | First-page component sum ms | App CPU over four pages ms | Later 100-request batch ms | App footprint after workload MiB |
| --- | ---: | ---: | ---: | ---: | ---: |
| 0 | 21.0 | 134.6 | 865.7 | 97.0 | 20.6 |
| 1,000 | 21.3 | 135.1 | 881.3 | 97.0 | 20.6 |
| 10,000 | 22.2 | 142.8 | 1029.1 | 97.0 | 22.3 |
| 50,000 | 21.9 | 148.9 | 1429.8 | 98.0 | 22.2 |

Preparation remains about 21–22 ms, while the 50,000-rule workload adds about 564 ms to the difference of app-CPU medians. Request-batch and later-navigation medians remain close. This isolates native declarative-rule initialization work without a third-party background script, and demonstrates that preparation timing alone misses work. It does not explain all of uBlock Lite's approximately 3.1 seconds of additional app CPU: uBlock's rules are more numerous and more complex, and its initialization performs other operations. Stack profiling is required before assigning the whole cost to one component. Two further peak-counter launches per control measured 20.7 MiB with zero rules versus 111.4 MiB with 50,000 rules (110.8–112.0 MiB), settling to 22.6 MiB afterward. A transient native-rule memory cost exists without a third-party background script, but it does not account quantitatively for uBlock's full peak.

Supplemental filter compilation uses the production exporter and cached `WKContentRuleList` compiler, independently of DNR. Each size has one deliberately new salted input and two repeated identical calls:

| Input/native rules | Export median ms | First compile/lookup ms | Cached compile/lookup ms |
| --- | ---: | ---: | ---: |
| 1,000 / 1,000 | 14.4 | 6.0 | 0.38–0.99 |
| 10,000 / 10,000 | 134.7 | 34.5 | 1.33–1.40 |
| 50,000 / 50,000 | 669.6 | 174.4 | 4.76–4.85 |

The first 50,000-rule export plus compile takes 848.4 ms, excluding network download. Current conversion emits one native rule per synthetic domain. These are simple salted domain rules, not the same input shape or rule expansion as the historical report; do not treat the changed totals as a longitudinal speedup/regression.

Repeated preparation in the same `IOSFilterPreparation` instance reuses its task/JSON, and unchanged installed JSON skips compilation. The benchmark deliberately reruns conversion to measure it. Across a new app instance, only downloaded text and compiled rule lists persist: the converted JSON cache is in memory. A large cached list can therefore still pay conversion work on restart even when native compilation is a cheap lookup. Persisting versioned converted output is worth testing if large supplemental lists are common.

All exporter controls compiled, empty output returned no rule list, and the physical-device regression passed real network blocking, exception allowance, cosmetic hiding/clearing, cache identity, and preservation of working rules after an invalid compile. These are native checks rather than JavaScript-only regular-expression tests.

## What runs on iOS

The app uses `WKWebExtensionController`, not Firefox/Gecko or Once's JavaScript extension runtime. Four bundled packages run through WebKit: uBlock Origin Lite, Dark Reader, SponsorBlock and Violentmonkey. User-installed XPIs are unpacked and their manifests adapted for WebKit; this does not make every Firefox API available.

The host parses bundled and installed extensions serially during `prepare()`. It creates contexts even for disabled entries. Enabled contexts are loaded; only uBlock Lite's background is explicitly awaited. The preparation task is reused afterward. Installed-package catalog reads, orphan-directory pruning, context construction and permission setup happen on the main actor. The app starts preparation when extension settings are applied, and navigation awaits the same task. These timings measure the browser host; the real application's concurrent shell startup can overlap that work.

The recently added AMO page shim is injected at document start into every top frame. Its origin check returns immediately outside `https://addons.mozilla.org`; observers and the install bridge are set up only on AMO. The built production shim is 132,189 bytes because the CommonJS preload barrel also includes protocol and browser-API construction code. The benchmark includes the actual production webpack entry. The isolated `amo` control injects that bundle without an extension controller, measuring its ordinary-page cost. A separate build experiment aliases the import directly to the same `amoShim` module and produces 3,507 bytes, a 97.3% reduction. The normal entry rebuilt with all relevant production webpack plugins has the same SHA-256 as the measured bundle. The narrow-import variant is a size experiment only; it was not used in the device timings or adopted in production, and still needs AMO install behavior tests before shipping.

The supplemental userscripts path is separate from Violentmonkey on iOS. `UserscriptInjection` registers enabled wrappers in frames and performs URL matching inside JavaScript; disabling Violentmonkey does not remove those wrappers. Supplemental filter lists use native `WKContentRuleList`. Fetching, conversion and hashing run off the main actor; equal preparations and compiled hashes are cached. These existing optimizations are present in this checkout and are not new changes from this investigation.

Relevant implementation: [host](../../apps/mobile/ios/App/App/WebExtensionHost.swift), [navigation and settings](../../apps/mobile/ios/App/App/InAppBrowserSurfacePlugin.swift), [AMO bridge](../../apps/mobile/ios/App/App/AmoInstallBridge.swift), [page shim](../../apps/mobile/src/amoPageShim.ts), [installer](../../apps/mobile/ios/App/App/WebExtensionManagement.swift), [archive reader](../../apps/mobile/ios/App/App/ExtensionArchive.swift), [supplemental scripts and filters](../../apps/mobile/ios/App/App/ExtensionSupport.swift).

## Experimental design

Each page is a real HTTP navigation to an in-app loopback server. It contains 1,500 paragraphs and 400 CSS rules, settles for one second, then performs 90 animation frames with 50 DOM mutations and one forced layout per frame. Each page subsequently fetches 100 responses of 16 KiB with caching disabled. All successful traffic samples must transfer exactly 1,638,400 bytes. The local server removes Internet and device-tunnel variation from the page workload, although its work contributes to the app-process CPU measurement.

Each launch loads four pages. The first page measures initial WebKit/content-script startup; the last three measure repeated navigation. Every main configuration has one excluded conditioning launch and five retained fresh-process launches. Order rotates and reverses by round. Extension storage, compiled caches and OS file caches persist, so these are conditioned process-cold measurements, not fresh-install or reboot-cold timings.

The independent sampling unit is a launch. For repeated navigation and traffic, the median of its three later pages is computed first, then the median/range across launches. Pages and frame intervals within one launch are correlated. The evidence also records same-round differences from a control; the sample count is too small for a precise population estimate or a device-wide regression threshold.

`prepareMs` ends after creating and preparing the host and registering the AMO or supplemental script. First-page time is the sum of preparation, surface construction/attachment, and first `didFinish`. It excludes application-process launch, Capacitor, fixture setup, and the catalog microbenchmarks inserted between preparation and surface creation. It is not first paint or full Once launch time. Catalog probes separately measure the first call and the average of 20 cached calls; 20 repeated `prepare()` calls measure the cached readiness path.

Dark Reader must produce its injected styles, unmatched wrappers must remain inert, matching synthetic packages must execute exactly once per page, catalogs must have the expected enabled count, and completed launches must have unique request tokens. The runner polls for the matching completed token rather than waiting a fixed 14 seconds and accepting an old result. Failed launches are preserved and rejected by the summarizer.

The fixture has no advertising requests, matching SponsorBlock video, installed Violentmonkey script, cross-origin iframe tree, or long-running application. Blocking therefore saves no bytes here. Results describe overhead on this workload and cannot estimate the net benefit of blocking a real advertising-heavy page.

## Package size and install-path review

The four bundled iOS extensions occupy 54,044,965 uncompressed bytes (51.54 MiB). uBlock Origin Lite accounts for 44,162,342 bytes (42.12 MiB), about 82% of that total. Dark Reader contributes 3,183,564 bytes, SponsorBlock 4,743,430 bytes and Violentmonkey 1,955,629 bytes. These are vendor-resource inputs, not compressed App Store download deltas or resident memory. The bundle versions are retained in the JSON.

uBlock Lite's three manifest-enabled static rulesets contain 112,256 rules across 12,618,840 JSON bytes: 6,644 uBlock rules, 49,463 EasyList rules, and 56,149 EasyPrivacy rules. Disabled resources and additional extension logic make up the rest of its bundle. The manifest count is not a runtime query of uBlock's final rule selection, which can change through its background initialization or saved settings.

The installer downloads into a bounded temporary file and memory-maps the result; it does not intentionally hold the whole maximum-size archive in a growing heap buffer. SHA-256 verification, extraction and manifest adaptation run in detached tasks. Extraction validates paths, sizes and checksums and processes one file at a time within an autorelease pool. Limits are 200 MB compressed, less than 250 MiB expanded, 100 MiB per file and 10,000 archive entries. Memory mapping does not eliminate resident/footprint or page-fault costs, and each decompressed file still needs a buffer.

The main-actor work includes constructing the `WKWebExtension`, loading its context, rendering catalog icons, serializing the installed catalog and removal/pruning. The number of files as well as compressed bytes matters for extraction because every file is decompressed, CRC-checked and written separately. The archive benchmark uses real cached packages and retains SHA-256 hashes, versions and sizes; the source-level limits are not performance guarantees at their maxima.

Three consecutive local review/install/remove cycles per archive, in one process; medians below. The first cycle is retained, so this is a small warmed-file installation experiment, not three independent app launches.

| Package/version | Compressed MiB | Expanded MiB / files | Review ms | Context load and catalog commit ms | Removal ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| consent-o-matic 1.1.5 | 0.09 | 0.26 / 23 | 8.3 | 8.6 | 7.1 |
| clearurls 1.27.3 | 1.05 | 3.15 / 171 | 44.1 | 8.3 | 13.4 |
| bitwarden-password-manager 2026.10.0 | 20.78 | 78.56 / 195 | 345.5 | 10.5 | 17.7 |
| localcdn-fork-of-decentraleyes 2.6.86 | 27.93 | 82.84 / 2,211 | 679.5 | 7.1 | 153.4 |

All candidates loaded, but loadability is not feature compatibility. Bitwarden, ClearURLs and LocalCDN returned unsupported-permission warnings, including `webRequestBlocking`; LocalCDN also reported a command-manifest warning. Their intended filtering or password-manager behavior was not benchmarked. Consent-O-Matic returned no review warnings. No user account, password vault or real browsing data was used.

LocalCDN's median removal took 153 ms, versus 18 ms for Bitwarden despite similar expanded byte counts. This includes WebKit data cleanup and package deletion; it is not a measured 153 ms main-thread stall. However, `store.remove()`/`prune()` perform synchronous filesystem deletion on the main actor in production. Large package removal and abandoned-package cleanup merit a main-thread trace and an off-main-actor deletion experiment.

## Priorities and practical limits

1. **Investigate the transient native-rule/extension peak and delayed initialization CPU first.** The all-bundle app process peaks at 379 MiB and consumes 4.2 CPU-seconds across the initial workload; measuring only the 180 ms `prepare()` interval misses most of this cost. Profile rule translation, background initialization and allocations on the full app, and compare representative rule subsets while verifying filtering. The minimal DNR experiment establishes a contribution, not a complete causal breakdown. Preserve first-document blocker readiness when experimenting with initialization policy.
2. **Measure the tradeoff between eager warming and deferred initialization.** Settings application starts the host even before browsing. A reader-only session can initiate extension work it never uses. Compare initialization after the initial shell/reader work, or on demand, against the resulting first-navigation latency; the current navigation gate already awaits readiness. This requires full-app measurements before changing policy.
3. **Avoid expensive work for disabled and large installed catalogs.** Fifty disabled packages cost roughly 47 ms of additional preparation. Persist enough display metadata to avoid constructing disabled contexts during initial preparation, loading them when needed. Trace package removal and orphan pruning before moving their filesystem work off the main actor; the measured LocalCDN removal spans 148–161 ms, including WebKit cleanup.
4. **Persist versioned converted supplemental filters if large lists are common.** Compiled-rule caching already works. The remaining 50,000-rule conversion costs about 670 ms and the prepared JSON currently does not survive a new host instance. Preserve content/version invalidation and generation checks when testing a persistent converted-output cache.
5. **Give the AMO shim a narrow export.** The isolated import change reduces its minified size by 97.3%. It is a small ordinary-page optimization with a straightforward test surface, not a substitute for the larger initialization work. Exercise installation, catalog changes and page lifecycle on AMO before adopting it. URL prefiltering for supplemental userscripts is a secondary candidate at large counts.

No production optimization or default-extension change is included in this investigation. Only benchmark tooling, validation and evidence/report files changed.

The measurements do not cover full Once launch time; complete process-group or per-tab memory; lower-memory phones or the oldest supported iOS release; foreground-to-background suspension; sustained energy use; real ad/tracker savings; performance of matching SponsorBlock video and nontrivial userscripts; or many cross-origin iframes. The native functional suite covers several of those features' behavior, which does not establish their performance. No battery saving, leak, universal slowdown or safe memory threshold is inferred.

An attempted Instruments Time Profiler recording timed out with “Timed out waiting for device to boot: iPhi (27.0.1)”; `xctrace list devices` reported the phone offline, while `devicectl` ran the benchmark and transferred results successfully. No usable allocating-stack trace was obtained. The physical peak counters and timings remain measured results; exact allocation attribution and total child-process accounting remain open.

## Validation and evidence integrity

- 112 successful configuration launches are retained: 109 four-page launches (436 pages) and three diagnostic launches for rule compilation, native filter behavior and real archive installation. Twenty four-page launches are conditioning rounds excluded from summaries. Peak and lifecycle runs are separately identified rather than mixed into the main timing medians.
- All retained launches reported nominal thermal state at their recorded start/end checks and low-power mode off. This is not continuous thermal or power instrumentation.
- Four abandoned conditioning launches are retained separately with the reason: the first synthetic manifest omitted a description, which WebKit reports as a manifest error on disabled contexts. The fixture was corrected before the measured scaling rounds; no failed sample is counted as a successful performance result.
- Native Release harness builds passed. The production Swift implementation is unchanged across the builds; hashes identify the different harness instrumentation. The only dependency substitutions are a `JSObject` typealias for the Capacitor import and a no-op inspector hook.
- All 47 selected existing mobile tests passed, covering archive validation/downloads, iOS adaptation and AMO lifecycle, portable filters, extension settings and startup. All six added benchmark-evidence tests passed, including conditioning exclusion, per-launch aggregation, stale/duplicate/incomplete data rejection and incorrect extension states.
- The iOS 26.5 simulator native host suite passed Dark Reader, SponsorBlock video seeking, Violentmonkey execution/storage/recovery, uBlock tools and navigation behavior. The native management suite passed first-install/update rollback, catalog persistence, direct-URL update and changed-identity rejection.
- The physical iPhone filter regression passed all assertions. Every nonzero synthetic DNR page blocked its probe, every matched-content test counted the expected executions, and every ordinary traffic batch transferred all expected bytes.
- JavaScript lint, repository structural limits and `git diff --check` passed. The isolated physical-device and simulator test apps were removed after collecting results. The real Once app's code and user data were not changed.

## Reproduction

The app identifier is `com.zmarn.once.extensionbenchmark`. Keep it distinct from the real Once application. Builders use the already-fetched vendor bundles and the repository's configured development signing team.

```sh
npm run build:packages
node tests/e2e/mobile/build-extension-benchmark-ios.js /tmp/once-ios-benchmark
xcodebuild -project /tmp/once-ios-benchmark/Bench.xcodeproj -scheme Bench \
  -configuration Release -destination 'generic/platform=iOS' \
  -derivedDataPath /tmp/once-ios-benchmark/build -allowProvisioningUpdates build
xcrun devicectl device install app --device DEVICE_ID \
  /tmp/once-ios-benchmark/build/Build/Products/Release-iphoneos/Bench.app
ONCE_BENCH_OUTPUT=artifacts/ios-extension-impact/main \
  node tests/e2e/mobile/run-extension-benchmark-ios.js DEVICE_ID 5
```

The runner defaults to `bare,amo,disabled,blocker,vm,sponsor,dark,all`. `ONCE_BENCH_MODES` selects a matrix; `ONCE_BENCH_WARMUP=0` omits the default excluded conditioning round. Use a fresh output directory; the runner refuses to overwrite existing samples. `ONCE_BENCH_MEMORY=1` adds idle, surface-detach and context-unload observations. `scripts0,scripts100,scripts1000` selects unmatched supplemental wrappers. `installed10,installed50,installeddisabled50,matched10` selects minimal installed packages. `dnr0,dnr1000,dnr10000,dnr50000` selects minimal installed declarative-rule extensions.

`rules` tests genuinely uncached compilation using a unique domain salt, followed by two identical cached calls at each rule count. `filter-regression` performs native loopback blocking, exception, cosmetic, failure-preservation and clearing checks. To include cached real XPIs, set `ONCE_BENCH_XPI_DIR` during the build to a directory of slug subdirectories, each containing one pinned XPI; optionally select slugs with `ONCE_BENCH_XPI_SLUGS`. The `install` mode records the SHA-256 and version of each archive and times three local review/install/remove cycles. It excludes network download and confirmation UI.

Regenerate the JSON with:

```sh
node scripts/summarize-ios-extension-impact.js artifacts/ios-extension-impact \
  docs/benchmarks/ios-extension-impact-2026-10-26.json
```

The source harness is [extension-benchmark.swift](../../tests/e2e/mobile/extension-benchmark.swift), with [support and diagnostic workloads](../../tests/e2e/mobile/extension-benchmark-support.swift), [builder](../../tests/e2e/mobile/build-extension-benchmark-ios.js), [runner](../../tests/e2e/mobile/run-extension-benchmark-ios.js), and [summarizer](../../scripts/summarize-ios-extension-impact.js). Historical reports are preserved.
