# Sync compatibility gate

Implemented in development alongside central AI; no staged rollout or legacy package is required.
All devices under development must receive this gate. Earlier clients without it cannot be remotely stopped by this feature.

## Version contract

`once_sync_compat` is a plaintext metadata record managed separately from data replication:

```json
{"_id":"once_sync_compat","schema":1,"minSyncProtocol":2}
```

`minAppVersion` may name the minimum release for display. It does not participate in the comparison.
The current build's `SYNC_PROTOCOL` is 2. Protocol 1 is the legacy format; protocol 2 includes shared AI/vault data and AI/search addon capabilities. Ordinary application releases do not raise the requirement.

Future incompatible format changes must increment the supported protocol and invoke `requireSyncProtocol(version)` before writing the new shared representation. Extend `requiredSyncProtocol` to recognize that representation in existing local and remote records. Do not simply change the current build number or overwrite a lower marker locally.

The marker uses compare-and-swap, verifies writes, and honors the highest requirement among conflicting revisions. Unknown schemas and malformed records stop sync. Local high-water marks are stored in non-replicated `_local` records, scoped by a hash of the normalized destination without credentials. Missing or lowered metadata after a higher requirement was seen cannot re-enable sync. Fresh legacy databases start at protocol 1.

## Transport and mutation enforcement

The initial settings pull, maintenance and push wait for compatibility preflight. Existing version-2 vaults and AI/search addon manifests in either database establish protocol 2 before replication. Local format requirements are remembered, including changes made while sync is unconfigured.

A dedicated metadata change feed observes live raises. Unsupported requirements cancel both directions and invalidate callbacks. Network failures also pause replication; retries restart through preflight rather than PouchDB's automatic bidirectional retry. The metadata record is filtered out of ordinary pull and push.

Vault and addon writes through the shared list store verify compatibility before persisting. Configured but unavailable sync defers these mutations. Local reading and ordinary pending edits remain available. The current data-sync session also stops tab publication and maintenance. Extension background tab sync, which writes directly over HTTP, checks compatibility before every operation with its own persistent destination history.

This is cooperative client-side protection, not a server authorization boundary: cancellation cannot recall a request already sent, and clients predating the gate do not participate. Use server-side enforcement if that guarantee is needed later.

## UI and verification

The existing sync status reports `update-required`, supported/required protocols and optional minimum app release. Settings → Sync keeps a warning with the installed app version, Update Once and Check again. It has no override and never clears pending data. Metadata errors and connectivity errors remain distinct from an update requirement.

Regression tests cover legacy initialization, existing current data, destination history, downgrade, metadata conflicts/deletion, failed/offline prerequisites, stale callbacks, extension HTTP checks and two real Pouch clients stopping/resuming across a protocol increase. Browser fixtures verify light/dark layouts at 390px and 1280px, keyboard recheck, update navigation and the absence of uploaded data while blocked. Existing central AI, tab sync, and pairing tests remain part of validation.

Validation on 2026-10-12: the full unit suite passed (1,183 tests), followed by nine focused compatibility/background regressions including retry after a failed first marker write. Electron/app integration passed 110 tests. Browser validation passed 20 tests across compatibility, central AI and tab sync. Repository type/static/boundary checks and Firefox, Chrome, Electron type and mobile web development builds passed. Live browser inspection covered 390px/1280px layouts, both themes and keyboard recheck. Packaged native-device update flows were not exercised.
