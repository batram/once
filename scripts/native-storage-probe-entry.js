const PouchModule = require("pouchdb-browser")
const PouchDB = PouchModule.default || PouchModule
const { registerPlugin } = require("@capacitor/core")
const { nativePouchAdapter } = require("../packages/platform-mobile/dist/nativePouchAdapter")
const { nativeStorageConformance } = require("../tests/helpers/native-storage-conformance")
const bridge = registerPlugin("NativeDatabase")
PouchDB.plugin(nativePouchAdapter(bridge))
const open = () => new PouchDB("once-durability-probe", { adapter: "native-sqlite" })
globalThis.onceNativeProbe = {
  run: () => nativeStorageConformance(PouchDB, "once-native-conformance-" + Date.now()),
  async seed() {
    const db = open()
    const result = await db.put({ _id: "acknowledged-offline", value: "survives-webview-loss", _attachments: {
      "bytes.bin": { content_type: "application/octet-stream", data: "AAECA//+".repeat(600000) }
    } })
    await db.put({ _id: "_local/durable-checkpoint", value: result.rev })
    // Deliberately leave the handle open: the next step kills the process, without close().
    return { rev: result.rev, info: await db.info() }
  },
  async verify() {
    const db = open()
    try {
      const doc = await db.get("acknowledged-offline", { attachments: true })
      const checkpoint = await db.get("_local/durable-checkpoint")
      if (doc.value !== "survives-webview-loss" || checkpoint.value !== doc._rev || doc._attachments["bytes.bin"].data !== "AAECA//+".repeat(600000)) {
        throw new Error("Durability verification failed")
      }
      return { ok: true, rev: doc._rev, attachmentBytes: 3600000, info: await db.info() }
    } finally { await db.close() }
  },
  async rangePages() {
    const name = "once-range-probe-" + Date.now()
    const execute = request => bridge.execute({ ...request, name })
    const opened = []
    const iterator = async options => {
      const result = await execute({ operation: "iteratorOpen", initialPage: true, ...options })
      if (result.iterator) opened.push(result.iterator)
      return result
    }
    await execute({ operation: "open" })
    try {
      await execute({ operation: "batch", operations: Array.from({ length: 260 }, (_, i) => ({
        type: "put", key: i.toString(16).padStart(6, "0"), value: btoa("old-" + i)
      })) })
      const first = await iterator({ reverse: true, limit: 129 })
      if (first.rows.length !== 128 || atob(first.rows[0].value) !== "old-259" || first.done) throw new Error("Invalid first range page")
      await execute({ operation: "batch", operations: [{ type: "put", key: "000083", value: btoa("new") }] })
      const next = await execute({ operation: "iteratorNext", iterator: first.iterator })
      if (next.rows.length !== 1 || atob(next.rows[0].value) !== "old-131" || !next.done) throw new Error("Paged snapshot changed")
      const empty = await iterator({ limit: 0 })
      if (empty.rows.length || !empty.done) throw new Error("Zero limit read rows")
      const keys = await iterator({ values: false, limit: 1 })
      if (keys.rows.length !== 1 || "value" in keys.rows[0]) throw new Error("Keys-only read returned values")
      const large = "AAECA//+".repeat(600000)
      await execute({ operation: "batch", operations: [{ type: "put", key: "000000", value: large }] })
      const oversized = await iterator({})
      if (oversized.rows.length !== 1 || oversized.rows[0].value !== large || oversized.done) throw new Error("Large first page was truncated or exceeded its budget")
      const following = await execute({ operation: "iteratorNext", iterator: oversized.iterator })
      if (following.rows[0].key !== "000001") throw new Error("Paging skipped a row after a large value")
      return { firstPage: true, snapshot: true, reverse: true, limit: true, keysOnly: true, largeValueBytes: 3600000 }
    } finally {
      for (const id of opened) await execute({ operation: "iteratorEnd", iterator: id })
      await execute({ operation: "destroy" })
    }
  },
  async atomicity() {
    const name = "once-atomicity-probe"
    await bridge.execute({ operation: "open", name })
    try {
      let rejected = false
      try {
        await bridge.execute({ operation: "batch", name, operations: [
          { type: "put", key: "01", value: "YQ==" }, { type: "invalid", key: "02" }
        ] })
      } catch { rejected = true }
      const read = await bridge.execute({ operation: "getMany", name, keys: ["01"] })
      if (!rejected || read.values[0] !== null) throw new Error("Failed batch was not rolled back")
      await bridge.execute({ operation: "batch", name, operations: [{ type: "put", key: "01", value: "YQ==" }] })
      const { iterator } = await bridge.execute({ operation: "iteratorOpen", name })
      await bridge.execute({ operation: "batch", name, operations: [{ type: "put", key: "01", value: "Yg==" }, { type: "put", key: "02", value: "Yw==" }] })
      const page = await bridge.execute({ operation: "iteratorNext", name, iterator })
      await bridge.execute({ operation: "iteratorEnd", name, iterator })
      if (page.rows.length !== 1 || page.rows[0].value !== "YQ==") throw new Error("Snapshot saw later writes")
      return { rollback: true, snapshot: true }
    } finally { await bridge.execute({ operation: "destroy", name }) }
  }
}
