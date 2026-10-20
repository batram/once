# Once Lite: extension module loading

Measured 20 October 2026 on Samsung SM-G780G, Android 13,
WebView 155.0.8059.43. Baseline: `1f75e5a7`, the committed
[settings/startup follow-up](once-lite-startup-followup.md).
Samples are in [once-lite-module-loading.json](once-lite-module-loading.json).

## Implementation

Only the generated Android Lite copy of bundled uBlock is transformed.
The vendor directory, other engines, installed third-party extensions and the
uBlock manifest remain unchanged.

The build follows uBlock's 57-module static startup graph. esbuild combines it
into shared ESM chunks while retaining entry facades for modules imported by
other extension pages/workers and the existing runtime diagnostic entry points.
These facades and the background share module instances and live bindings.
Function names are preserved, tree shaking/minification are disabled, and
license comments are retained. esbuild is pinned to the already-used 0.28.2.

Dynamic imports stay external at their original extension-root URLs. In
particular, dynamically loaded scriptlet sources are not bundled or rewritten.
The build rejects computed dynamic import paths needing review and refuses to
replace a classic-script URL with an ESM facade.

uBlock's side-effect bootstrap (`vapi-common`, `vapi-background`,
`vapi-background-ext`) must run before modules that use `vAPI.defer` at top
level. The generated `start.js` awaits those original modules in order before
loading the bundled startup entry. This explicitly handles the ordering
dependency exposed by the initial splitting experiment.

The background HTML preloads the resulting static graph: 32 module/chunk URLs,
including bootstrap dependencies, instead of the original 57-module graph.
Preloading alone was also tested before bundling.

Permissions are still decided by the existing broker/native asset path.
Generated chunks are private package resources; the manifest's
web-accessible-resource permissions are not broadened.

## Ordinary process-cold launches

Five baseline launches, five preload-only launches, and five launches of the
final bundled build. Existing profile and caches retained, both extensions
enabled, five configurations and 109 stories. App foreground/unlocked; debug
production-identity APK. First launches after installation are included.

Medians in milliseconds:

| Measurement | Baseline | Preload only | Bundled + preloaded |
| --- | ---: | ---: | ---: |
| Extension hand-off complete | 3,212.4 | 3,310.2 | **3,188.9** |
| JavaScript fetch endpoint in uBlock | 1,021.7 | 704.8 | **606.4** |
| Configurations populated | 2,244.7 | 2,314.1 | 2,336.6 |
| First stories | 2,678.7 | 2,777.4 | 2,753.7 |
| JavaScript resources before readiness | 59 | 59 | **35** |
| All observed uBlock resource entries | 63 | 63 | **40** |

The JavaScript fetch endpoint is the last `.js` response completion before the
shell's extension-ready mark, measured from the uBlock background navigation.
Late diagnostic imports are excluded from that endpoint and JavaScript count.
The all-resource count includes diagnostic entries.

JavaScript fetching finishes about **415 ms / 41% earlier**, with **24 fewer
JavaScript resource loads**. Ordinary extension readiness improves by only
**24 ms / 0.7%** in the medians. Its ranges overlap substantially:
3,155–3,473 ms before and 2,976–3,567 ms after.
This is **not a demonstrated material everyday-startup improvement**.
Configurations and first stories are also not demonstrably faster.

The async bootstrap changes the relationship between DOMContentLoaded and
actual module execution. It also moves the start of uBlock's internal `vAPI.T0`
clock relative to graph loading. Consequently, DOMContentLoaded and uBlock's
`allReadyAfter` duration must not be used for direct before/after speed claims.
The shell hand-off mark remains the same readiness condition in both builds.
All measured launches restored uBlock's compiled filter snapshot successfully.

## Alternating post-install comparison

The baseline and bundled APKs were also alternated in order A1 B1 B2 A2 A3 B3.
Each run reinstalls its selected APK before a process-cold launch, without
clearing data. This balances order better than the ordinary sequential series,
but measures a different launch condition. It must not be pooled with the
ordinary retained-install samples.

| Pair | Baseline ready | Bundled ready | Saving |
| --- | ---: | ---: | ---: |
| 1 | 4,843.5 ms | 4,230.5 ms | 613.0 ms |
| 2 | 5,089.9 ms | 4,551.9 ms | 538.0 ms |
| 3 | 4,575.3 ms | 4,444.2 ms | 131.1 ms |

The post-install medians are **4,843.5 → 4,444.2 ms**, about **399 ms / 8.2%**
faster. Each matched comparison favors bundling; savings range from
131 to 613 ms. With three pairs this remains a small experiment, not a
statistical guarantee.

## Interpretation

Bundling reduces request count and dependency-wave delivery, and helps the
post-install launches measured here. The remaining work can consume most of
that saving during ordinary cached launches: application/native setup, settings
handoff and compiled-filter restoration still run alongside module loading.
The earlier [native asset trace](once-lite-native-assets.md) describes those
costs. Reducing module fetch time alone does not imply the same reduction in
protected-navigation readiness.

The failed initial bundle was not included in the successful benchmark series.
Its bootstrap-order issue was corrected and covered by a regression test.
The preload-only experiment is retained here to distinguish its effect from
bundling rather than presenting only the most favorable measurement.

## Verification

- 13 module/Android-packaging tests passed: dependency cycles, re-exports,
  dynamic-code exclusion, path boundaries, idempotent preload insertion,
  preserved live module state, classic-script protection, explicit bootstrap
  ordering and computed-import rejection.
- Six Samsung instrumentation tests passed: all engine regressions plus native
  public/private asset permissions. The filtering test now verifies a
  `set-constant` uBlock scriptlet both before and after an engine restart, in
  addition to network/cosmetic filtering and popup behavior.
- Production/dev Android packaging, lint, structural limits, boundaries and
  whitespace checks passed.

The production-identity app is restored without profiling hooks afterward,
and the installed APK is compared with the local build by SHA-256. Temporary
comparison APKs are removed from the phone. Raw traces and local APK snapshots
remain under `artifacts/lite-startup-detail/`, ignored by Git.
