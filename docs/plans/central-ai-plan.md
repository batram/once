# Central AI, compact settings, and one sync passphrase

Status: implemented and locally validated (2026-10-12). This supersedes the
initial draft that used separate AI/addon passphrases and inline consumer forms.

## Product contract

AI & Search is an overview: default model, named connections, search, registered
consumers, and a link to Sync. Editors are separate settings pages with Save and
Cancel. Model discovery updates the mounted picker without discarding drafts.
Consumer rows link to the owning addon's settings or Reader settings. Overrides
are edited there; an absent override inherits the global default.

One SyncVault owns the encryption passphrase, recovery key and unlock session.
Add-ons and AI & Search have separate per-device participation switches. Leaving
one section copies and verifies its local data first and leaves the other section
and other devices alone. Setup and security controls live only under Sync.

## Storage and migration

The existing addon_vault document and device pin retain their identities. Version
2 envelopes hold both namespaces and cause older clients to fail closed. Existing
passphrase and recovery wrapping remain valid. Namespace-specific mutations must
not prune another namespace's credentials. Connection edits and token writes are
atomic, targeted changes serialized across windows; deleting a connection deletes
its token and exposes affected selections.

What4 migration is an explicit startup/upgrade operation, fingerprinted by the
source configuration and credential bindings. It verifies the destination before
upgrading the package. Distinct imports remain distinct and existing defaults win.
Legacy credentials remain usable until the old addon is replaced. An existing
separate draft AI vault is retained until it can be unlocked, verified and imported.

## Requests and reader behavior

Provider-neutral requests resolve against one settings snapshot. Credentials stay
in the host. AI/search grants, bounded concurrency, deadlines, cancellation and
structured error codes apply to all consumers. Truncated streams are failures.
Each reader session has one host and document identity; navigation invalidates its
requests. Reader-close subscriptions compose with speech cleanup.

Formatting proposes block structure rather than replacing the article with model
prose. Links, media, tables, code and math are preserved. Plain-text blocks may repair
whitespace, paragraph breaks and line-end hyphenation only after wording validation;
unsupported text changes and reordered blocks are rejected. AI OCR uses explicit cloud recognition, actual page
numbers, preserved paragraphs and cancellable page extraction. Saving is explicit
and records AI provenance; restore retains the original session document.

## Audit findings addressed

- Discovery results/drafts were discarded by full-page refreshes.
- Consumers were hard-coded and every consumer added another inline form.
- Independent vaults required multiple passphrases and pairing unlocked only one.
- Whole-settings writes and separate token writes could overwrite or partially save.
- Deleted connections retained credentials; incomplete streams were accepted.
- Multiple extension panels could process one request; mobile cleanup was replaced.
- Formatting lost links/media, saved results lost provenance, and PDF work could not cancel.
- Migration markers were global and not tied to the source being upgraded.
- Reader CSS contained an accidental 10.25rem font and duplicate base layers.

## Acceptance

Exercise shared unlock/recovery, independent switches, cross-window edits, failures,
conflicts, migration retries, legacy compatibility, credential cleanup/redaction,
stream completion, grants, one-owner routing and stale-result suppression. Verify
reader preservation, provenance, PDF page order, paragraph boundaries and cancellation.
Update author documentation and mocked-provider end-to-end fixtures. Inspect live
UI in desktop/mobile widths and light/dark themes, including geometry, keyboard,
drafts, errors and progress. Run relevant tests and repository checks after visual
inspection. Real-provider and native-device checks must be reported separately.

## Validation record

- Live browser inspection covered the overview, connection editor, reader override,
  shared-sync destination, mobile geometry and desktop geometry. Automated browser
  tests cover 390px and 1280px settings in light and dark themes, persistent discovery
  drafts, keyboard Cancel/focus return, override navigation, shared unlock and
  independent dataset switches against a local CouchDB fixture, reader restoration,
  explicit saving, and cancellation of delayed mocked provider requests. The final
  browser run passes 13 tests, including What4 conversation regressions.
- Regression tests cover atomic/cross-window credential edits, endpoint binding,
  truncated streams, request deadlines, local/encrypted What4 fingerprints, recovery
  of the old separate AI vault, deferred override cleanup, structured formatting,
  mixed PDF text/OCR page progress, cancellable PDF rendering and extension ownership.
- Repository validation includes type checks, lint/CSS checks, cascade and structural
  checks, dead-code and package-boundary checks, Firefox/Chrome development builds,
  Electron type build and mobile web development build. Electron/app integration and
  the full unit suite run with mocked transports. The Electron/app integration run
  passes all 110 tests.
- Remaining rollout checks: real-provider account/model behavior, installed extension
  browser smoke tests, packaged Electron UI, Android/iOS device cancellation and OCR,
  and camera-based pairing. No real provider credentials were used for automated tests.

The historical `ai_vault` document remains readable/replicable only to recover draft
installations; new AI sync writes exclusively to the shared versioned `addon_vault`.
User-facing security setup is named Encrypted sync. Dataset switches never run the
upgrade migration, so an explicit opt-out cannot be immediately undone by migration.

## Database compatibility

Shared vault and addon writes now use the [sync compatibility gate](sync-compatibility.md).
The current build supports sync protocols 1–2; introducing AI/search capabilities or
version-2 vault data requires a verified protocol-2 marker before shared data changes.
Future gate-aware clients pause both replication directions and request an app update
when they encounter a requirement they cannot support. Existing ungated development
clients must be updated; this does not retrofit enforcement into earlier binaries.
