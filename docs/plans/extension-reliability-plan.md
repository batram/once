# Plan: dependable add-ons and browser extensions

Created 2026-09-04. Status: implementation and local validation complete;
native Android and iOS validation remain release checks.

## Outcome

Keep Once's declarative add-on model and sandboxed script API, while making
updates preserve user data, ordinary state writes leave running add-ons alone,
and failures recover predictably. Improve browser-extension configuration in
the same pass, without widening the supported extension allowlist.

This is the implementation follow-up to the review of the current add-on and
Firefox-extension support. The original feature plans remain historical:
[story add-ons](story-addons-plan.md) and [browser extensions](firefox-extensions-plan.md).

## Work and acceptance

1. **Preserve add-on state.** Updates retain enabled state and storage and
   validate existing options against the replacement schema. Serialize local
   read/modify/write operations against the newest document. Cover populated
   updates and concurrent storage writes with regression tests.
2. **Reconcile add-ons individually.** Storage changes do not restart sandboxes;
   option changes use the settings message; only changed definitions restart.
   Serialize reconciliation, dispose removed entries, and refresh collectors
   only when their definitions or relevant options change. Test storage,
   options, removal, and overlapping refreshes.
3. **Own asynchronous work and lifecycle.** Associate story operations with the
   invocation that created them. Share startup readiness, bound frame loading
   and script activation, retain failure counts across recreated frames, and
   settle work on disposal. Namespace badge identity by add-on. Test overlapping
   work, readiness, recovery, disposal, and identical local badge names.
4. **Make add-on management reviewable.** Render installed entries with versions,
   enabled state, device availability, retry, and removal. Preview installs and
   updates, including capabilities; checking must not install. Fetch and verify
   replacement code before saving it. Retain the JSON editor as an advanced
   interface. Test update preservation and failed verification.
5. **Help authors.** Provide a minimal package, public author types, and a local
   validation command that checks manifests and script integrity. Document the
   lifecycle and management behavior and keep platform limits explicit.
6. **Reconcile browser settings.** Remember Once-managed filter subscriptions
   and remove deleted ones without erasing independent uBlock choices. Use
   independent serialized application per extension, suppress stale adoption,
   and report application outcomes. Observe Violentmonkey changes and use
   persistent storage identity to distinguish deletion of the last script from
   lost storage. Test removal, queues, stale results, and empty-script state.
7. **Preserve mobile filter meaning.** Skip rules whose constraints cannot be
   represented instead of broadening them. Retain supported exceptions, report
   skipped rules, and prevent stale Android settings application. Add fixtures
   for options, exclusions, exceptions, and overlapping applications.
8. **Validate integration.** Run focused regression suites, type/lint/boundary
   checks, and packaged Electron add-on/extension tests on a hidden desktop.
   Exercise available mobile checks. Record separately any iOS device or native
   platform validation that cannot be performed on this Windows host.

## Implementation constraints

- Preserve protocol and manifest compatibility where possible. Existing scripts
  must continue to work without rewriting their handlers.
- Runtime status is local to a device; manifests/options/storage remain synced.
- Keep the last working installed version when package verification fails.
- Source fetching stays credential-free. Capability enforcement remains in the
  host; no additional script privileges are introduced.
- Do not introduce an extension store, widen the browser extension allowlist,
  deploy a hosted Firefox sandbox, or claim iOS-device evidence from desktop tests.
- Validate behavior at the ownership boundary rather than only testing helper
  functions in isolation.

## Evidence and completion log

Before implementation: shared packages built successfully; 86 selected existing
add-on/browser-extension tests passed. Source review identified missing coverage
for state-preserving updates, runtime reconciliation, and wrapper/frame recovery.

Implemented:

| Step | Result and owner |
| --- | --- |
| 1 | `upsertAddon` preserves storage and enabled state and validates existing options. `AppSettings.updateAddons` serializes local document patches; storage and generated option controls use it. |
| 2 | `AddonReconciler` owns registrations by identity. Storage does not restart them; options use the live settings message. Reconciliation and explicit retries are serialized. |
| 3 | Script operations keep the supplied story object's request identity. `AddonSandbox` owns readiness, frame deadlines and persistent failure counts; session disposal settles pending work. Badge lookups include add-on identity. |
| 4 | Installed entries expose enable/disable, remove, retry and device status. Install/update candidates show capabilities and require explicit application. Shared package verification checks cached and fetched code and trial activation before persistence. |
| 5 | Public `OnceAddonApi` types, `scripts/validate-addon.js`, the editor schema, and `examples/addons/story-length` provide an author starting point. `ADDONS.md` describes the current API and management flow. |
| 6 | `ExtensionSettingsCoordinator` serializes each extension independently, suppresses obsolete results, observes Violentmonkey storage, and reports status in toolbar tooltips. Filter ownership restores prior selections; a storage-generation marker distinguishes final-script deletion from reset. |
| 7 | The actual Android parser and bridge have portable-rule and stale-download tests. The iOS exporter skips unsupported constraints conservatively. `EXTENSION_COMPATIBILITY.md` defines coverage and recovery limits. |
| 8 | Shared build, repository and app type checks, lint, boundaries, structure, semantic controls, dead-code checks, unit tests, packaged Electron tests, and the mobile web add-on test passed. |

Validation on 2026-09-04:

- Complete unit suite: **514 passed, 0 failed, 0 skipped**. This includes the
  new lifecycle, concurrent invocation, namespaced badge, update preservation,
  independent settings queue, last-script deletion, mobile rule, and Android
  settings-generation cases.
- App extension-settings integration: **3 passed**, including concurrent
  add-on document patches without lost storage keys.
- Packaged Electron: **11 passed** on a hidden desktop. The added update
  scenario verifies preview-before-install, state preservation, rejection of
  a broken replacement hash, disable, and removal. The storage/options scenario
  checks that the original sandbox frame stays connected.
- Mobile web: **1 add-on scenario passed** against a fresh mobile E2E bundle.
- The update scenario was also run alone to capture and inspect the installed
  add-on UI. Management controls and generated options were visible.
- `npm run package:electron -- --nokill` produced the current Electron package.
  `npm run check:types`, Electron/mobile type checks, repository lint,
  boundary/structure/semantic-control/dead-code checks, and the starter validator
  passed.

Validation caught and resolved an optional-field round-trip regression, a test
cleanup-order mistake, and a stale Android manifest assertion. The extension
runtime initially exceeded the structural limit; extracting the settings
coordinator restored the check without adding an exception.

## Remaining validation and deliberate limits

- Native Android/GeckoView and iOS/WebKit device/simulator runs were not performed
  in this implementation pass. In particular, the Swift exporter has not been
  compiled or executed here; desktop JavaScript tests are not substitute evidence.
- Mobile supplemental filtering is deliberately conservative. Unsupported
  exceptions can cause that input's blocking rules to be withheld rather than
  applied too broadly. iOS receives combined list text. Full uBlock behavior
  remains available independently through Android's bundled extension.
- Existing filter subscriptions have no historical ownership record. Their
  first observed selection becomes the baseline; ownership cannot be inferred
  retrospectively without risking independently selected lists.
- Local patches are serialized within one app instance. Cross-device concurrent
  edits still follow the existing synced-document conflict behavior.
- Firefox still needs its configured hosted sandbox. This work does not deploy
  one or create an add-on index.
