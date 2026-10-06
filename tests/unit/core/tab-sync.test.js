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

test("tab state: YouTube starts where it was left, and states are validated and described", () => {
  const { withYouTubeStart, isYouTubeVideo, readMediaState, readReaderPosition, describeTabState } = require("../../../packages/core/dist")
  assert.equal(withYouTubeStart("https://www.youtube.com/watch?v=abc&t=5s", 754.9), "https://www.youtube.com/watch?v=abc&t=754s")
  assert.equal(withYouTubeStart("https://youtu.be/abc", 61), "https://youtu.be/abc?t=61s")
  assert.equal(withYouTubeStart("https://m.youtube.com/watch?v=abc&start=9", 0.4), "https://m.youtube.com/watch?v=abc")
  assert.equal(withYouTubeStart("https://example.com/watch?v=abc", 30), "https://example.com/watch?v=abc")
  assert.equal(isYouTubeVideo("https://www.youtube.com/feed/subscriptions"), false)
  assert.equal(readMediaState({ currentTime: 12, duration: Infinity, paused: true, rate: 1 }), null)
  assert.deepEqual(readMediaState({ currentTime: 12, duration: 600, paused: false, rate: 1.5 }), { currentTime: 12, duration: 600, paused: false, rate: 1.5 })
  assert.equal(readReaderPosition({ fraction: 1.2, anchor: null }), null)
  assert.deepEqual(readReaderPosition({ fraction: 0.4, anchor: { index: 7, text: "x".repeat(100) } }).anchor.text.length, 64)
  assert.equal(describeTabState({ media: { data: { currentTime: 754, duration: 3910, paused: false, rate: 1 } } }), "▶ 12:34 / 1:05:10")
  assert.equal(describeTabState({ "reader.scroll": { data: { fraction: 0.4, anchor: null } } }), "Read 40 %")
  assert.equal(describeTabState({ "addon:x": { data: 1 } }), "")
})
