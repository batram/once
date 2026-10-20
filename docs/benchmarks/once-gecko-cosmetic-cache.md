# Packed uBlock cosmetic snapshots — Samsung, 2026-10-20

Baseline: `c4266d3e`. This change reduces the object graph that crosses IndexedDB's structured-clone boundary when uBlock restores extended filtering. It preserves synchronous filtering, readiness checks, the request suspension barrier, extension identity and permissions. Copying became substantially cheaper, but the controlled phone comparison did not show an end-to-end startup speedup.

## Representation and behavior

The previous extended-filter snapshot traversed roughly 939,000 values. Its specific cosmetic database held 78,548 hostname entries, 92,403 selector-string slots and 395,610 integer link entries. Other extended engines added their own hostname tables and links; the generic cosmetic map had 39,027 entries.

The Android copy now stores:

- Hostname and generic-selector maps as sorted key/value columns: concatenated UTF-16 strings with offsets, or numeric typed arrays. Runtime lookup uses binary search. Editing a restored table materializes a normal Map once.
- Selector strings as a shared string plus offsets. A lookup extracts and caches the required string synchronously; it does not fetch additional data or defer a filtering decision.
- Linked-list entries as `Uint32Array`. The first append materializes a normal array, preserving incremental filter edits.

All table bytes are loaded before readiness. The new decoder validates types, lengths, offsets and key ordering before exposing the tables. It avoids eagerly reconstructing every Map entry and selector string; it does not eliminate copying of the underlying bytes.

Existing version-1 snapshots remain readable. After a successful legacy restore, the normal selfie writer is scheduled for an idle interval at least 60 seconds later, respecting a longer configured delay. Existing invalidation supersedes that timer. A distinct `once-packed-1` marker makes an older build reject the new encoding and use its existing compiled-list fallback. Settings and filter selections are not converted or discarded.

The startup/request-release code and traffic implementation are unchanged. The earlier generation checks and all-task settlement remain in place. The untouched upstream bundle continues to serve other platforms; only the Android adaptation uses this encoding.

## Isolated measurements and correctness

A temporary IndexedDB database in the extension origin held raw and packed copies of the same real snapshot. It was deleted afterward. Reads were interleaved within one process:

| Representation | Read, median | Validation/reconstruction, median | Read + reconstruction, median |
|---|---:|---:|---:|
| Original graph | 206 ms | <1 ms | 206 ms |
| Packed columns and lazy string slots | 103.5 ms | 15.5 ms | 119 ms |

The combined median fell by 87 ms, approximately 42%. A separate, interleaved in-memory `structuredClone` test removed database I/O: raw copying took a median 121 ms (118–169 ms range); packed copying took 5 ms (4–5 ms), or 17 ms including validation (15–21 ms range). Packing is performed when writing the cache, outside the measured startup read. This isolates representation costs in an already-running engine; it is not a cold-start saving. JSON packing was slower and was rejected. Packing only integer links helped, but retained most of the string/map graph.

On the real profile, 2,534 hostname cases produced identical ordered selector results. All 39,027 generic-map entries returned identical values. A separate timing pass over 2,534 hostname cases took 29–36 ms with the original database and 36–45 ms with the packed database. A synthetic mix of 5,000 generic hits and 5,000 misses took 1–2 ms with Map and 2–3 ms with packed lookup. These are many-lookups totals, not per-page costs; extracting strings and binary search introduce a small lookup tradeoff. The first in-place edit of a packed specific-hostname database took 64–75 ms in a separate diagnostic, and a generic map took 17–18 ms, versus less than the 1 ms timing resolution for the original structures. Subsequent edits were below 1 ms. This is the cost of materializing editable structures; a normal filter-list rebuild can instead clear them first.

## Controlled startup comparison

Samsung Galaxy S20 FE SM-G780G, Android 13, GeckoView `155.0.20260903215306`; existing production profile and all extensions retained.

The final experiment uses **one debug APK containing both variants**, selected before process launch by a temporary app-private marker. A is the exact baseline Android uBlock adaptation; B is the packed implementation. The native app, APK layout, package identity, ABI and other extensions stay fixed. The selector, duplicate baseline assets and timing probes are not shipped.

Protocol:

1. Run blocks in **A–B–B–A** order, with three measured launches per block.
2. For each block, run one setup launch, explicitly write the current snapshot through uBlock's own writer, and wait five seconds for its deferred registry persistence. Then run a second warmup and require a valid cached snapshot.
3. Pause automatic list updates in both benchmark variants, without changing the saved preference. Check a canonical hash of the hostname/scriptlet/header/HTML/generic filter content across blocks. No extension or filtering function is disabled.
4. Force-stop the app and cool it for at least 60 seconds. Require thermal status 0, AP temperature at most 33.5°C and battery temperature at most 33°C before the block; record conditions before and after every measured run. Keep AC charging and screen wakefulness consistent.
5. Each measured launch force-stops the app, observes the shell for 15 seconds, then opens the same local HTTP fixture over ADB reverse. Require the expected cache format, a valid selfie, and normal uBlock production defaults.

Cache read duration includes registry access, IndexedDB delivery and scheduling. Restore duration includes validation and installing the filtering structures. Both variants have the same lightweight timing probes. The page report includes transport overhead and is not a first-paint metric. Native acceptance can precede uBlock's release of the network request.

| Measurement, median of six launches per variant | Baseline A | Packed B |
|---|---:|---:|
| Cosmetic cache read | 323 ms | 289.5 ms |
| Extended-filter restore/validation | 0 ms | 18 ms |
| Read + restore | 323.5 ms | 307.5 ms |
| uBlock ready after its T0 | 536.5 ms | 556 ms |
| Native browser open resolves | 1,376.6 ms | 1,379.4 ms |
| Local page load report | 1,838.5 ms | 1,854.5 ms |

The cache read fell by 33.5 ms (10.4%); including restore/validation, the reduction was 16 ms (4.9%). **There is no demonstrated end-to-end startup gain:** page reports were 1,838.5 ms versus 1,854.5 ms, with overlapping ranges of 1,691–2,109 ms and 1,640–2,021 ms. uBlock readiness and native acceptance also did not improve consistently. The larger isolated copying gain is partly hidden by concurrent startup work and the new validation cost.

All twelve navigations reported the same 600-byte `transferSize` and 300-byte `encodedBodySize`. First network requests began 7–13 ms after uBlock's all-ready timestamp; the barrier was not bypassed. Every run used a valid cached snapshot, 276,265 network filters and 248,845 accepted cosmetic entries. All four blocks had the same canonical content hash. Pre-block AP temperatures were 32.8–33.5°C, all recorded thermal statuses were 0, and AC charging remained on and battery level stayed at 100%. The per-run temperatures and all samples are in the JSON.

Warmups and incomplete pilot attempts are excluded. The pilots exposed an overly strict cold-idle temperature target and the need to wait for uBlock's three-second deferred registry write; the final protocol above was applied to both variants from the beginning. An initial foreground check also incorrectly treated an inactive Android lock-screen window as focused and was corrected before measurements.

The experiment controls more variables than the earlier APK-install comparison, but remains a small balanced sequence, not a randomized trial. Disk caches are retained, and the shell's live feeds remain enabled. Reported differences are observations on this phone and profile, not guaranteed savings on every launch.

The final commit also incorporates upstream Electron-test-only changes through `748e5a85`; they do not change the Android application or the measured codec.

## Validation and final state

Nine focused tests cover matching parity, legacy reads, safe rejection on rollback, append/clear/rewrite behavior, numeric/string indexes, malformed tables, upstream serialization with exact UTF-16 content, deferred migration, and generated ES-module loading. Existing startup/readiness tests continue to cover rejected or invalid snapshots and generation changes.

The 353-test mobile suite passed before the final generated-module test was added; the nine focused cosmetic tests also passed afterward. Three native instrumentation methods passed on a fresh temporary development profile: first page/warm switches, held catalog/filter/userscript readiness with memory-pressure protection, and paint-reset invalidation. The full pre-push checks run on the final committed sources.

The normal production build automatically changed a legacy snapshot to `once-packed-1` during its idle interval, without an explicit create call. The canonical content hash before and after matched. A subsequent cold restart reported a valid selfie and used `PackedFilterIndex`.

A native rendered-page check verified actual cosmetic filtering after that cold restart. The matching element had height 0, removing its class restored height 64 px, and restoring the class hid it again. The control remained 80 px tall, and the screenshot was visually inspected. The fixture used an ephemeral local `.test` DNS mapping because the profile's existing rules exempt loopback URLs from generic hiding. No exception or filter setting was changed. The mapping affected only the running process's default preferences and is cleared by restart. This functional check is separate from the startup fixture and is not a complex-site performance test.

Automatic asset updates were paused only in memory during the idle-migration check and restored by restarting the normal application. The saved preference was unchanged.

The final application contains neither the benchmark selector nor its timing probes or paused updater. Temporary databases, marker files, profiles and inspector forwarding are removed, and the original screen-wake setting is restored. Normal automatic updates remain enabled according to the user's saved settings. Raw experiment files stay in ignored `artifacts/gecko-startup-detail/`; the accompanying JSON records sanitized measurements and conditions.
