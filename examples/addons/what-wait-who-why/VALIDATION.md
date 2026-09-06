# Validation record — 2026-09-06

## Installation follow-up

ZIP/folder importing and Electron's linked-directory picker were added after the
initial AI-addon validation below. The updated full unit suite passes **544 tests**.
The packaged Electron addon suites pass **11 tests**, including ZIP import,
folder replacement, cached-code survival after renderer reload, the native picker
IPC path, persisted directory selection, file-change reload, and unloading without
deleting source files. The OS directory dialog's return value is supplied by the
fixture; filesystem operations, IPC, runtime activation and watching are real.

Chrome and Firefox each pass their addon suite with ZIP import included; the
mobile-web suite passes **3 tests** including ZIP selection. Native Android/iOS
file-picker interaction was not exercised in this follow-up. Mobile exposes ZIP
selection; desktop browsers additionally expose folder import where supported.
`npm run check`, Electron packaging, production extension builds, and the example
validator pass. Webpack still emits bundle-size warnings.

Firefox exposed a clipped Add-ons settings editor caused by the structured-editor
container's hidden overflow. The panel now uses the normal scrolling settings
container, and the rerun passed. The first new Electron fixture run stopped during
source setup because the test harness's local HTTP transport was disabled; enabling
that fixture transport corrected the setup and both new flows then passed.

## Initial AI-addon validation

This implementation was exercised with deterministic local fixtures. No paid AI
calls, real provider tokens, addon auto-installation, or search deployment were
needed. Provider payloads and normalization use fixtures, not live-service claims.

| Check | Result |
| --- | --- |
| Complete unit suite | 538 passed |
| Packaged Electron addon suites | 9 passed |
| Chrome addon suite | 1 passed, including the AI tray flow |
| Firefox addon suite | 1 passed, using its configured hosted sandbox |
| Mobile-web addon suite | 2 passed |
| Native Android addon fixture | 1 passed on an isolated API 36 emulator |
| iOS native device/simulator | Not run; no iOS hardware/runtime available on this Windows host |
| Repository `npm run check` | Passed |
| Electron packaging and production extension builds | Passed |
| Example manifest/script validator | Passed |

The repository check includes line endings, lint, CSS contracts, structure,
semantic controls, types, unused code, package boundaries, and development builds
for Electron, both extensions, and mobile.

## Exercised behavior

- Host protocol: tray validation, cross-story isolation, cancellation and stale
  completion, two-request limits, credential destination binding, response limits,
  secret exclusion, and preserved HTTP status.
- Settings: local development persistence and disable controls, preserved drafts,
  prompt defaults/restoration, and masked device-local credentials.
- Addon: question and ordinary titles, software and ambiguous-person titles,
  unavailable content, long content, summaries, follow-ups, history bounds,
  search disabled, native search adapters, SearXNG fallback, citation mapping,
  malformed JSON/response shapes, authentication errors, and rate limits.
- Electron UI: repeated close/open, row replacement and movement, two independent
  expanded stories, keyboard focus, unchanged read state, and reset after renderer
  reload. A delayed fixture request reached the server before Stop; the server
  observed its connection close within 1.5 seconds, exercising IPC cancellation.
- Android: article extraction plus authenticated explanation and summary calls
  through the native Capacitor HTTP transport.

## Remaining limits and observed issues

Native Capacitor HTTP has no cancellation API. Stop invalidates the invocation and
suppresses its result; the underlying request may finish within native timeouts.
Its response is buffered before the 1 MiB check. iOS needs separate device testing.

The broader existing Android smoke suite failed before reaching its addon phase:
the embedded-browser extension test expected an ad to be blocked but observed it
loaded. The independent native addon fixture passed. This result does not certify
the unrelated ad-blocking path.

The host's `java` on PATH resolves to Java 8 while `JAVA_HOME` points to JDK 21.
The existing Android runner uses `JAVA_HOME` and built successfully; no persistent
Java configuration was changed. Production webpack builds emitted bundle-size
warnings, and Android Gradle reported deprecations.

Test-only stale-element and post-reload setup issues were corrected during UI
validation. The isolated emulator also reached its launcher's time limit once;
it was restarted and the native fixture passed again. The test emulator was shut
down afterward; the user's existing emulator was left alone.
