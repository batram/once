# Mobile extension improvements — 2026-10-04

Follow-up to [the original investigation](mobile-extension-impact.md). This records implementation changes and their validation; the original measurements are preserved. Machine-readable evidence, raw retained samples, native behavior results and baseline summaries are in [mobile-extension-improvements.json](mobile-extension-improvements.json).

## Implemented changes

### iOS supplemental filtering

The exporter now emits WebKit-compatible regular expressions. ABP's separator-or-end alternative is represented by separate native rules, and the domain prefix uses a supported capturing group. Empty lists clear the installed rules without trying to compile `[]`. A failed compilation leaves the existing working list installed. Unsupported constraints continue to be omitted conservatively; this remains a portable subset, not a complete ABP implementation.

List downloads and conversion run in a detached utility task, with cooperative cancellation when the selection changes. Equal selections reuse pending/completed work for one hour. Download text also has a one-hour freshness window and retains the previous offline fallback. Input URLs and JSON keys are deterministic. The generation check before and after compilation prevents obsolete settings from replacing newer settings.

Compilation uses a SHA-256 content identifier and first checks WebKit's persistent compiled-rule store. Equal compilations share a pending task, unchanged installed JSON skips compilation (the marker is reset when the browsing surface closes), and the latest four compiled identifiers are retained. Hashing also runs outside the main actor. This reduces repeated settings work; it does not eliminate the cost of a genuinely new large list.

The physical iPhone loopback regression verifies actual blocking, exception allowance, ordinary requests, cosmetic hiding, clearing, preservation after invalid compilation, and a stable cache identifier. It uses the production exporter/compiler. The regression manually installs/removes the returned rules in WKWebView; it does not drive the complete Capacitor settings UI.

### Android supplemental filtering

The bridge no longer registers a blocking `webRequest` listener when no effective network rules are present, including cosmetic-only lists. It removes the listener when network rules are cleared. The bridge version is now 1.1.1 so installed built-in extensions update.

Safe domain-anchored rules are indexed by hostname. Requests check their hostname and parent-domain buckets, with the original regular expression still making the final decision. Generic/wildcard patterns retain the linear fallback. Credential-bearing or malformed URLs also fall back to preserve matching behavior. The unit suite compares indexed and original decisions and verifies that 10,000 unrelated domain rules require zero regular-expression evaluations. This is a domain-heavy workload improvement, not a claim that every arbitrary filter list has constant-time matching.

### iOS bundled extension startup

All enabled contexts still load. The host explicitly awaits uBlock Origin Lite's background readiness before first navigation, while Dark Reader, SponsorBlock and Violentmonkey use WebKit's event-driven background loading. The policy was benchmarked in an isolated build before adoption, then the native behavior suite was rerun against the final production source.

The native suite passed on iOS 26.5 simulator, covering Dark Reader, SponsorBlock video seeking, first-page userscript execution, background recovery and GM storage without duplicate execution, extension tool navigation, and uBO tools. Iphi supplied physical-device timing and the filter regression. The timing fixture does not contain a matching video or an installed VM script, so those features have functional coverage but no representative workload performance claim.

## Measurements

These are sequential before/after sessions, not randomized paired trials or full Once app launch measurements. See the original report for fixture details. iOS uses a release harness on physical Iphi (iPhone 16 Pro Max, iOS 27.0.1). Android emulator measurements use Android 16 / API 36 arm64 and GeckoView 155.0.20260903215306. Each launch loads four pages.

| Metric | Before | After | Interpretation |
| --- | ---: | ---: | --- |
| Iphi, all-extension host preparation | 288.6 ms | 160.7 ms | 44% lower median; 4 launches per version |
| Iphi, first page finished, including surface preparation | 387.7 ms | 298.2 ms | 89.5 ms / 23% lower median |
| Iphi, later navigation | 37.1 ms | 32.7 ms | 12 later pages per version; secondary metric |
| Iphi, frame interval p95 | 17 ms | 17 ms | No change in this fixture |
| Android emulator, empty bridge, 100 requests | 693 ms | 595 ms | Listener removal; sequential-session noise applies |
| Android emulator, 10,000 domain rules, 100 requests | 2,098 ms | 801 ms | 62% lower median |
| Android emulator, all default extensions, 100 requests | 717 ms | 823 ms | No general default-extension speedup established |

Android request figures use the last three pages of each retained launch. Round zero conditions the persistent profile and is excluded, leaving three launches and nine warm batches per mode. Every batch fetches the same 100 × 16 KiB payload; no request is saved through ad blocking. The new emulator 10,000-rule batches range from 594–1,136 ms; the empty bridge ranges from 442–730 ms. The all-default case ranges from 572–2,682 ms and is too variable for a small general performance claim. Aggregate package-process PSS is recorded in the JSON, but session variability and emulator load prevent attributing a memory improvement confidently.

### Physical Android before/after

The connected SM-G780G (Android 13, arm64) completed 16 launches per version: bare, empty bridge, 10,000 domain rules, and default extensions, with four rounds each. Bridge catalogs confirm version 1.1.0 before and 1.1.1 after. Round zero is retained as conditioning and excluded from summaries. The default set is the Once bridge, uBlock Origin and Violentmonkey, with no installed VM scripts.

| Configuration | Request batch before | Request batch after | Process PSS before | Process PSS after |
| --- | ---: | ---: | ---: | ---: |
| No extensions | 910 ms | 827 ms | 541.0 MiB | 532.2 MiB |
| Empty bridge | 1,055 ms | 722 ms | 551.1 MiB | 545.0 MiB |
| Bridge + 10,000 domain rules | 1,568 ms | 825 ms | 644.9 MiB | 561.6 MiB |
| Default extensions | 1,197 ms | 993 ms | 734.2 MiB | 669.3 MiB |

The large-list request median fell 47.4%, and its process PSS median fell 83.3 MiB (12.9%). The corresponding memory ranges do not overlap: 642.1–654.1 MiB before versus 547.7–572.3 MiB after. These are aggregate PSS snapshots after the workload, not peak memory or per-extension allocations.

The fixture travels through a Wi-Fi ADB reverse tunnel. The bare control also improved 9.1%, demonstrating session/transport variation. Relative to that control, the large-list request ratio fell from 1.72× to approximately 1.00×. This is descriptive normalization, not a randomized causal estimate. Timing ranges overlap: the large-list warm batches span 1,320–3,129 ms before and 622–1,394 ms after. The empty bridge being faster than the bare control in the second session is another reason not to overinterpret small absolute differences.

Thermal service status was 0 (normal) before and after the baseline session, and 1 (light) after the optimized session. The device remained plugged in at 100%; reported battery temperature rose from 27.8°C to 33.9°C across the complete comparison. Sessions were sequential and not thermally matched. No battery savings or absence of throttling is inferred.

After the fixes, the default extension set still adds about 137 MiB of measured process PSS relative to the bare control. Median harness readiness is 1,146 ms versus 382 ms bare, an additional 764 ms; these are Gecko browsing-surface measurements, not full application launches. Frame interval p95 remains about 8.48 ms across the tested configurations. The fixes remove avoidable supplemental-filter costs; the bundled engines and extensions still have meaningful startup and memory costs.

### iOS compilation cost

| Input domain rules | Exported native rules | Export median | First compile/lookup call | Subsequent cached calls |
| --- | ---: | ---: | ---: | ---: |
| 1,000 | 2,000 | 9.2 ms | 31.1 ms | 0.45–0.48 ms |
| 10,000 | 20,000 | 81.9 ms | 204.9 ms | 2.20–2.23 ms |
| 50,000 | 100,000 | 417.7 ms | 974.1 ms | 9.84–13.88 ms |

All controls and sizes compiled successfully. The original exporter failed on the normal domain/separator shape, so its faster invalid export is not an equivalent successful baseline. Correct conversion generates two rules per synthetic domain and more JSON. The production improvement comes from correctness, moving expensive work off the main actor, reusing preparation, and avoiding repeated compilation. These timings include hashing and store access; they preceded the final change that moved hashing off the main actor. The final physical regression passed after that scheduling change.

## Validation and reproduction

- All 126 mobile unit tests pass, including portable filter semantics, empty-list listener lifecycle and stale-settings handling.
- Targeted JavaScript lint, structural limits and `git diff --check` pass.
- The final `Once Dev` iOS simulator application build and release physical-device harness build pass.
- Final native extension behavior passes on iOS 26.5 simulator; final native filter regression passes on Iphi.
- Android benchmark builds use the real GeckoEngine and extension assets, in an isolated package.
- Follow-up timing evidence covers 48 configuration launches and 192 page loads: 32 launches on physical Android, 12 on the Android emulator, and four on physical Iphi. Native filter/extension functional tests are additional.
- Isolated benchmark apps and the physical Android reverse tunnel were removed after collecting evidence.

Build harnesses with `node tests/e2e/mobile/build-extension-benchmark-ios.js` or `node tests/e2e/mobile/build-extension-benchmark-android.js`, then use Xcode or the cached Android Gradle wrapper to compile them. The runners require an explicit device identifier. `ONCE_BENCH_OUTPUT` selects a separate artifact directory; `ONCE_BENCH_MODES` selects modes. On physical Android, use `adb reverse tcp:18765 tcp:18765` and `ONCE_BENCH_BASE=http://127.0.0.1:18765`; the emulator default is `http://10.0.2.2:18765`.

For the Android before/after comparison, build the baseline with `ONCE_BENCH_BRIDGE_REVISION=<base-revision>` and a separate output directory, then build the current assets without that variable. Use the base revision recorded in the evidence JSON. This changes only the generated benchmark assets, not the working tree.

Rebuild the report JSON with `node scripts/summarize-mobile-extension-improvements.js`. It validates sample completion and all native filter regression assertions before writing the evidence. Raw benchmark artifact directories are ignored by Git; the generated report JSON preserves the retained data needed to audit the conclusions.

## Remaining scope

Navigation-finished timing is not a first-paint metric. The checks establish extension behavior after navigation, not absence of a brief theme flash.

No battery/energy savings are claimed. Real-world ad-heavy browsing, long-lived sessions, representative installed userscripts, and matching-video performance still require controlled workloads and energy profiling. Correctness and synthetic request/startup timing do not establish those outcomes. Cold new-list compilation remains substantial for very large lists, and generic Android filter patterns still use a linear fallback.
