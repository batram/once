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
