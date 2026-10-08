const test = require("node:test")
const assert = require("node:assert/strict")
const {
  classifySyncDestination,
  comparePublications,
  isRetired,
  normalizeExcludedDomains,
  publishableUrl,
  readDeviceDoc,
  readSendDoc,
  readTabSyncOptions,
  readTabSyncSharedSettings,
  sendTarget,
  syncDestination,
  winningPublication
} = require("../../../packages/core/dist")

const id = "0123456789abcdef0123456789abcdef"
const other = "fedcba9876543210fedcba9876543210"
const device = (fields = {}) => ({
  _id: `dev_${id}`, type: "device", schema: 1, deviceId: id, epoch: 1, seq: 1, name: "Laptop",
  platform: "electron", appVersion: "1.0.0", sharing: true, updatedAt: "2026-10-06T10:00:00.000Z",
  windows: [{ id: "w1", focused: true, tabs: [{ id: "t1", navSeq: 2, url: "https://example.com/a", title: "A", mode: "web",
    active: true, openedAt: "2026-10-06T09:00:00.000Z", navigatedAt: "2026-10-06T09:30:00.000Z",
    selectedAt: "2026-10-06T09:30:00.000Z", activityAt: "2026-10-06T09:59:00.000Z",
    state: { media: { v: 1, capturedAt: "2026-10-06T09:59:00.000Z", data: { currentTime: 12 } },
      "addon:x:y": { v: 7, capturedAt: "2026-10-06T09:59:00.000Z", data: { kept: true } } } }] }],
  ...fields
})

test("only http(s) tabs outside excluded domains are published, without URL credentials", () => {
  assert.equal(publishableUrl("https://user:pass@example.com/a?b=1"), "https://example.com/a?b=1")
  assert.equal(publishableUrl("about:blank"), null)
  assert.equal(publishableUrl("moz-extension://abc/page.html"), null)
  assert.equal(publishableUrl("file:///etc/passwd"), null)
  assert.equal(publishableUrl("not a url"), null)
  const excluded = normalizeExcludedDomains("Bank.example, https://mail.example.org/inbox *.private.test")
  assert.deepEqual(excluded, ["bank.example", "mail.example.org", "private.test"])
  assert.equal(publishableUrl("https://bank.example/login", excluded), null)
  assert.equal(publishableUrl("https://www.bank.example/", excluded), null)
  assert.equal(publishableUrl("https://notbank.example/", excluded), "https://notbank.example/")
  assert.equal(publishableUrl("https://a.private.test/", excluded), null)
})

test("device documents are validated, and unknown state providers are carried along", () => {
  const doc = readDeviceDoc(device())
  assert.equal(doc.windows[0].tabs[0].state["addon:x:y"].data.kept, true)
  assert.equal(readDeviceDoc(device({ _id: `dev_${other}` })), null)
  assert.equal(readDeviceDoc(device({ deviceId: "short", _id: "dev_short" })), null)
  assert.equal(readDeviceDoc(device({ epoch: 0 })), null)
  assert.equal(readDeviceDoc({ ...device(), platform: "palm" }), null)
  const unsafe = readDeviceDoc(device({ windows: [{ id: "w", focused: false, tabs: [{ id: "t", navSeq: 1, url: "javascript:alert(1)" }] }] }))
  assert.deepEqual(unsafe.windows[0].tabs, [])
  assert.deepEqual(readDeviceDoc(device({ sharing: false })).windows, [])
})

test("publications order by epoch, then sequence, then revision, regardless of clocks", () => {
  const older = { epoch: 1, seq: 30, updatedAt: "2030-01-01T00:00:00.000Z", _rev: "40-a" }
  const newer = { epoch: 2, seq: 1, updatedAt: "2020-01-01T00:00:00.000Z", _rev: "2-b" }
  assert.ok(comparePublications(newer, older) > 0)
  assert.equal(winningPublication([older, newer]), newer)
  assert.equal(winningPublication([{ epoch: 1, seq: 5, _rev: "5-a" }, { epoch: 1, seq: 5, _rev: "5-b" }])._rev, "5-b")
  assert.equal(winningPublication([]), null)
})

test("a retirement hides a device until it rejoins with a higher epoch", () => {
  assert.equal(isRetired({ epoch: 3 }, { retiredEpoch: 3 }), true)
  assert.equal(isRetired({ epoch: 4 }, { retiredEpoch: 3 }), false)
  assert.equal(isRetired({ epoch: 1 }, null), false)
})

test("send documents name their target exactly", () => {
  assert.equal(sendTarget(`tsend_${id}_abc`), id)
  assert.equal(sendTarget(`tsend_${id}abc`), null)
  assert.equal(sendTarget(`tsend_${id.slice(1)}_abc`), null)
  assert.equal(sendTarget(`dev_${id}`), null)
  const send = { _id: `tsend_${id}_1`, type: "send", from: other, fromName: "Phone", url: "https://example.com/", title: "x",
    mode: "reader", createdAt: "2026-10-06T10:00:00.000Z" }
  assert.equal(readSendDoc(send).mode, "reader")
  assert.equal(readSendDoc({ ...send, url: "data:text/html,x" }), null)
})

test("sync destinations ignore credentials and classify reconnections", () => {
  assert.equal(syncDestination("https://user:pw@Sync.Example.test/once/"), "https://sync.example.test/once")
  assert.equal(syncDestination(""), "")
  const bound = "https://sync.example.test/once"
  assert.deepEqual(classifySyncDestination("https://a:b@sync.example.test/once", bound), { kind: "same", destination: bound })
  assert.equal(classifySyncDestination("https://sync.example.test/other", bound).kind, "different")
  assert.equal(classifySyncDestination("https://sync.example.test/other", "").kind, "initial")
  assert.equal(classifySyncDestination("https://sync.example.test/other", "", true).kind, "unknown-provenance")
  assert.equal(classifySyncDestination("", bound).kind, "disabled")
})

test("tab sync options fall back to defaults and accept only offered choices", () => {
  const options = readTabSyncOptions({ sharing: true, activityWindowMinutes: 60, freshnessWindowMinutes: 7, excludedDomains: ["A.test"] })
  assert.equal(options.sharing, true)
  assert.equal(options.activityWindowMinutes, 60)
  assert.equal(options.freshnessWindowMinutes, 30)
  assert.deepEqual(options.excludedDomains, ["a.test"])
  assert.equal(readTabSyncOptions(null).sharing, false)
  assert.equal(readTabSyncOptions(null).sendTarget, true)
  assert.equal(readTabSyncSharedSettings({ sendRetentionDays: 30 }).sendRetentionDays, 30)
  assert.equal(readTabSyncSharedSettings({ sendRetentionDays: 2 }).sendRetentionDays, 14)
})

test("tab sync starts off until asked, keeps devices that already shared on, and off means nothing acts", () => {
  const { effectiveTabSyncOptions } = require("../../../packages/core/dist")
  const fresh = readTabSyncOptions(null)
  assert.equal(fresh.enabled, false)
  assert.equal(fresh.offerAnswered, false)
  assert.equal(fresh.continueBanner, false, "offering to continue is opt-in")
  const sharedBefore = readTabSyncOptions({ sharing: true })
  assert.equal(sharedBefore.enabled, true, "a device sharing before the switch existed stays on")
  assert.equal(sharedBefore.offerAnswered, true, "and is not asked again")
  assert.equal(readTabSyncOptions({ sharing: true, enabled: false }).enabled, false)
  const off = effectiveTabSyncOptions({ ...fresh, sharing: true, sendTarget: true, continueBanner: true })
  assert.deepEqual([off.sharing, off.sendTarget, off.continueBanner], [false, false, false])
  const on = effectiveTabSyncOptions({ ...fresh, enabled: true, sharing: true, continueBanner: true })
  assert.deepEqual([on.sharing, on.sendTarget, on.continueBanner], [true, true, true])
})

test("tab state: YouTube starts where it was left, and states are validated and described", () => {
  const { withYouTubeStart, isYouTubeVideo, readMediaState, readReaderPosition, describeTabState, summarizeTabState } = require("../../../packages/core/dist")
  assert.equal(withYouTubeStart("https://www.youtube.com/watch?v=abc&t=5s", 754.9), "https://www.youtube.com/watch?v=abc&t=754s")
  assert.equal(withYouTubeStart("https://youtu.be/abc", 61), "https://youtu.be/abc?t=61s")
  assert.equal(withYouTubeStart("https://m.youtube.com/watch?v=abc&start=9", 0.4), "https://m.youtube.com/watch?v=abc")
  assert.equal(withYouTubeStart("https://example.com/watch?v=abc", 30), "https://example.com/watch?v=abc")
  assert.equal(isYouTubeVideo("https://www.youtube.com/feed/subscriptions"), false)
  assert.equal(readMediaState({ currentTime: 12, duration: Infinity, paused: true, rate: 1 }), null)
  assert.deepEqual(readMediaState({ currentTime: 12, duration: 600, paused: false, rate: 1.5 }), { currentTime: 12, duration: 600, paused: false, rate: 1.5 })
  assert.equal(readReaderPosition({ fraction: 1.2, anchor: null }), null)
  assert.deepEqual(readReaderPosition({ fraction: 0.4, anchor: { index: 7, text: "x".repeat(100) } }).anchor.text.length, 64)
  assert.equal(describeTabState({ media: { data: { currentTime: 754, duration: 3910, paused: false, rate: 1 } } }), "▶\uFE0E 12:34 / 1:05:10")
  assert.equal(describeTabState({ "reader.scroll": { data: { fraction: 0.4, anchor: null } } }), "Read 40 %")
  assert.equal(describeTabState({ "addon:x": { data: 1 } }), "")
  assert.deepEqual(summarizeTabState({ media: { data: { currentTime: 33, duration: 60, paused: true, rate: 1 } } }), { media: "paused", text: "0:33 / 1:00" })
  assert.deepEqual(summarizeTabState({ "reader.scroll": { data: { fraction: 0.4, anchor: null } } }), { text: "Read 40 %" })
  assert.equal(summarizeTabState({ "addon:x": { data: 1 } }), null)
})

test("the continue banner offers only a tab used moments before a recent publication, with a position", () => {
  const { continueCandidate } = require("../../../packages/core/dist")
  const now = Date.parse("2026-10-06T12:00:00.000Z")
  const iso = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString()
  const media = (minutesAgo) => ({ media: { v: 1, capturedAt: iso(minutesAgo), data: { currentTime: 754, duration: 3600, paused: false, rate: 1 } } })
  const tabOf = (id, activityAgo, fields = {}) => ({ id, navSeq: 1, url: `https://video.example/${id}`, title: id, mode: "web", active: true,
    openedAt: iso(300), navigatedAt: iso(300), selectedAt: iso(300), activityAt: iso(activityAgo), state: media(activityAgo), ...fields })
  const deviceOf = (deviceId, updatedAgo, tabs) => ({ deviceId, name: deviceId, updatedAt: iso(updatedAgo), windows: [{ id: "w", focused: true, tabs }] })
  const limits = { activityWindowMinutes: 15, freshnessWindowMinutes: 30 }
  const pick = (devices, dismissed = new Set()) => continueCandidate(devices, limits, dismissed, now)?.tab.id ?? null

  assert.equal(pick([deviceOf("phone", 2, [tabOf("long-session", 3)])]), "long-session", "selected long ago, used just now")
  assert.equal(pick([deviceOf("phone", 45, [tabOf("stale", 46)])]), null, "an old snapshot, however it arrived")
  assert.equal(pick([deviceOf("phone", -60, [tabOf("future", -61)])]), null, "a device clock an hour ahead")
  assert.equal(pick([deviceOf("phone", 1, [tabOf("idle", 20)])]), null, "not used recently before its publication")
  assert.equal(pick([deviceOf("phone", 1, [tabOf("plain", 2, { state: undefined })])]), null, "nothing to continue from")
  assert.equal(pick([deviceOf("phone", 1, [tabOf("a", 5), tabOf("b", 2)]), deviceOf("tablet", 1, [tabOf("c", 4)])]), "b")
  assert.equal(pick([deviceOf("phone", 1, [tabOf("a", 5), tabOf("b", 2)])], new Set(["phone:b:1"])), "a", "a dismissed tab is skipped")
})

test("pairing links round-trip the sync URL and an optional passphrase, and reject anything else", () => {
  const { encodePairingLink, decodePairingLink, describeSyncConnection } = require("../../../packages/core/dist")
  const syncUrl = "https://user:p%40ss%2Fword@sync.example.test/once"
  const link = encodePairingLink({ syncUrl })
  assert.match(link, /^once:\/\/pair\?v=1&u=[\w-]+$/)
  assert.deepEqual(decodePairingLink(link), { syncUrl })
  const withPassphrase = encodePairingLink({ syncUrl, passphrase: "correct horse ünïcode staple" })
  assert.deepEqual(decodePairingLink(` ${withPassphrase}\n`), { syncUrl, passphrase: "correct horse ünïcode staple" })
  assert.throws(() => decodePairingLink("https://example.com/?u=x"), /not a Once pairing link/)
  assert.throws(() => decodePairingLink("once://pair?v=2&u=x"), /newer Once/)
  assert.throws(() => decodePairingLink("once://pair?v=1&u=%%%"), /damaged/)
  assert.throws(() => decodePairingLink(`once://pair?v=1&u=${Buffer.from("ftp://x").toString("base64url")}`), /http/)
  assert.throws(() => encodePairingLink({ syncUrl: "" }), /Connect sync/)
  assert.deepEqual(describeSyncConnection(syncUrl), { database: "sync.example.test/once", user: "user" })
})
