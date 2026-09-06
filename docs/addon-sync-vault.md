# Encrypted addon sync

Once can sync installed addon packages, settings, and connection tokens in an
end-to-end encrypted vault. The sync database holds ciphertext; its password is
independent of the vault passphrase. This feature does not encrypt stories or
other Once settings.

## Setup

1. Configure CouchDB Sync and wait for **Up to date**. Use the same database on
   each device. All clients using the vault need a Once build that supports it.
2. Open **Settings → Once Add-ons → Sync add-ons and connections**.
3. Choose a separate sync passphrase of at least 12 characters, confirm it, and
   name the device. Choose **Enable encrypted addon sync**. This migrates all
   installed addons, their settings, available packages, and saved tokens.
4. Save the generated recovery key in a password manager. It is shown once.
5. On another device, connect sync, then choose **Unlock synced connections**
   and enter the passphrase once. Packages, settings, and tokens become ready
   together; no per-addon key entry or ZIP import is needed.

Native desktop and mobile clients offer remembering the vault key in protected
local storage. Browser profiles default to forgetting it across restarts;
**Remember in this browser** explicitly accepts weaker local protection.
An unlocked or compromised client can use its credentials regardless of storage
encryption. Secrets still never enter addon sandbox settings or scripts.

**Lock and forget on this device** removes its remembered vault key, pauses synced
addons and requests, and leaves encrypted replicated data available for the next
unlock. Linked development addons remain local. Normal operation works offline
after a successful unlock; edits replicate when the connection returns.

## Linked development folders

Directory links and filesystem paths are not synced. Open the linked addon's
settings and choose **Use this version on my devices** to create an approved
snapshot containing its current script, settings, and saved tokens. This requires
an unlocked vault. A removable directory link is unloaded after sharing; the
source files remain intact. Later filesystem edits do not update that snapshot.
Use the normal import/update review to publish another version.

## Recovery, updates and conflicts

Use **Use recovery key** during unlock if the passphrase is unavailable, then
set a new passphrase. Changing the passphrase re-encrypts the vault-key wrapper;
it does not rotate provider tokens or revoke previously authorized devices.
Without a passphrase, recovery key, or remembered key on a trusted device, the
encrypted data cannot be recovered by resetting the sync database password.

Concurrent offline edits pause synced addons instead of silently choosing a
winner. **Review concurrent versions** shows each version's author, time, addon
versions and token-presence indicators, never token values. Selecting a version
keeps that entire snapshot and discards the other branches. There is no automatic
field-by-field merge. Review deletions carefully before choosing an older version.
Create the vault on one device first, then unlock it on others. Independently
creating different vaults before replication completes produces incompatible
identities; these are rejected rather than merged. Restore the intended vault
from backup and use a fresh profile for a device bound to the other identity.

Removing an addon also removes its tokens and unreferenced packages from the new
snapshot. Clearing a token never falls back to an older local token. Replication
history and backups may retain old encrypted snapshots; vault deletion is not a
promise to erase every previous copy. A lost device may already know a token:
rotate it at the provider when revocation is needed.

The profile stays bound to its vault. Disabling/re-enabling sync to the same
database is supported; use a separate Once profile for another sync database.
This prevents accidentally merging two vaults by changing a URL.

## Storage and trust

The `addon_vault` document contains a versioned envelope and one complete encrypted
snapshot. Its plaintext includes approved manifests, enabled state, ordinary
settings, addon storage, verified script contents, and endpoint-bound credentials.
The legacy `addons` document is emptied after migration so old clients do not keep
running obsolete packages. Previously synced ordinary settings may still exist in
database history; migration cannot retroactively encrypt old backups.

The envelope uses Web Crypto AES-256-GCM with a fresh random 96-bit nonce for every
encryption and distinct associated-data contexts for the payload and key wrappers.
A random 256-bit vault key encrypts the snapshot. PBKDF2-HMAC-SHA-256 with a random
128-bit salt and 600,000 iterations derives the passphrase wrapping key. A separate
random 256-bit recovery key wraps the same vault key. The encrypted payload
authenticates the envelope metadata, including both wrappers.

Snapshots are limited to 4 MiB before encryption, including scripts. Existing
per-package limits still apply. This first version intentionally uses a complete
snapshot so package approval, settings, token replacement and deletion commit
together. Large addon collections may need separate encrypted package blobs in a
future format.

Only authenticated vault manifests can authorize synced connection requests.
The exact endpoint binding is preserved, credentials are injected by the host,
and package hashes are verified before saving or executing code. Vault corruption,
an unexpected vault identity, missing data after setup, and unresolved conflicts
fail closed. Local remembered generation/commit metadata detects previously seen
history rollback; this is not a global freshness proof. A sync server can withhold
updates, and a brand-new device cannot prove that a valid snapshot is the newest
without another trusted device. Device pairing and a device revocation protocol
are not part of this version.

Validation covers fixture clients, real PouchDB replication and conflict branches,
and the two-profile Electron workflow. No real provider token is needed by tests.
