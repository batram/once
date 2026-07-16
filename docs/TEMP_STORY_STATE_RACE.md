# Temporary investigation note: story read-state write ordering

This file is a handoff for independent fact and design review. It is not intended
as permanent user documentation.

## Observed behavior

The native iOS smoke test performs several rapid state transitions on the same
story:

1. Opening Reader Mode marks the story `read`.
2. The read-state control changes it from `read` to `unread`.
3. A second use of that control changes it from `unread` to `skipped`.
4. The app is terminated and relaunched.

During one failing run, the DOM showed the story as skipped before restart, but
the relaunched app restored it as read. Increasing the delays between UI actions
to three seconds did not resolve that failure. This made a simple WebDriver click
timing problem less likely, although it did not by itself prove a storage race.

The relevant E2E flow is in `tests/e2e/mobile/mobile.smoke.js`.

## Suspected race

`OnceApp.persistStoryChange()` mutated the in-memory `Story`, emitted the change,
and then awaited `storyStore.saveStory()`. Multiple callers could invoke it for
the same story without awaiting each other. Reader Mode awaits its `read` write,
but some story-list controls call `persistStoryChange()` without awaiting the
returned promise.

Consequently, writes for one story could overlap. The UI could already reflect a
newer value while an older asynchronous save was still in flight. If the storage
adapter completed or replicated those writes out of interaction order, restart
could restore the older value.

Relevant call sites include:

- `packages/app/src/OnceApp.ts`: `persistStoryChange()`
- `packages/ui-web/src/presenters/outline.ts`: Reader Mode marks the story read
- `packages/ui-web/src/StoryListItem.ts`: read/skip control changes story state

## Attempted correction

`OnceApp` already had a `storyWrites` map used by `addStory()` to serialize work
per story URL. The current working-tree change extracts that pattern into a
shared `queueStoryWrite()` helper used by both `addStory()` and
`persistStoryChange()`:

- A write waits for the previous promise associated with the same story URL.
- Writes for different story URLs remain concurrent.
- A rejected earlier write does not permanently block later writes, and a
  rejected write is logged so fire-and-forget UI callers cannot lose a failed
  save silently.
- The map entry is removed only if it still refers to the completing task.

`persistStoryChange()` mutates the in-memory story and emits the change event
synchronously at interaction time, so the UI updates optimistically and rapid
state cycling (e.g. `read -> unread -> skipped`) always computes the next state
from the latest value. Only the storage save is queued, and it persists a
snapshot (`Story.from_obj(story.to_obj())`) taken at interaction time, so each
save writes exactly its own transition regardless of later mutations. After a
save, the live story's `_id`/`_rev` are refreshed so the changes-feed echo
suppression keeps working.

Separately, `handleDatabaseChange()` previously replaced the in-memory story on
any revision mismatch, which could resurrect a stale doc when the changes feed
echoed an older local write after a newer one had already bumped the in-memory
revision. It now ignores change docs whose revision generation is lower than
the in-memory one.

Integration tests in `tests/integration/app/client-behavior.test.js` cover the
ordering (blocked first save, storage observes `read` then `skipped`), the
optimistic in-memory update, and the stale-echo suppression. They pass.

## Evidence that needs independent checking

The following conclusions should be reviewed rather than treated as proven:

1. Confirm whether the real mobile story store can actually commit or replicate
   two saves out of order. The integration test uses a deliberately blocked fake
   adapter and proves serialization, but does not reproduce the production
   adapter's exact failure mode. Two concrete pre-fix candidates identified by
   review: `PouchStoryStore.saveStory()` gives up after three 409 conflict
   retries and throws into an unawaited promise (a silently dropped final
   write), and the changes-feed echo replacement described above.
2. ~~Object aliasing in `saveStory()`~~ — addressed: queued saves now persist a
   snapshot taken at interaction time instead of the shared mutable `Story`.
3. ~~Stale-object writes via `addStory()` and database-change callbacks~~ —
   addressed: both write paths share the `queueStoryWrite()` queue, and
   `handleDatabaseChange()` no longer resurrects lower-generation docs. Note
   that `to_obj()` copies object-valued fields (tags, substories) by reference,
   so snapshots share those arrays with the live story; only scalar fields get
   true per-transition isolation.
4. ~~Read-state cycle~~ — verified: `StoryListItem` cycles `unread -> skipped`
   and anything else `-> unread`, matching the E2E expectation
   `read -> unread -> skipped`.
5. ~~Unobserved storage failures~~ — partially addressed: `queueStoryWrite()`
   now logs every rejected save. The rejection still propagates to awaiting
   callers; fire-and-forget callers get a console error rather than a
   user-visible notification.
6. Reproduce the original restart failure with storage/revision logging. The
   strongest confirmation would show the revision and `read_state` accepted by
   the local store and remote sync for every interaction. Also note that none
   of this protects against the app being terminated before WKWebView flushes
   the final IndexedDB commit; the E2E's pause before `terminateApp` is
   load-bearing for that case.

## Current test status

After removing an unrelated iOS external-browser round trip from the reader
smoke test, the complete iOS simulator test passed once. That successful run is
consistent with the ordering fix, but one pass is not enough to establish that
the suspected race was the sole cause of the earlier failure.
