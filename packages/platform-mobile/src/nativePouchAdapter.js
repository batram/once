import { AbstractLevelDOWN, AbstractIterator } from "abstract-leveldown"
import { Buffer } from "buffer"
import LevelPouch from "pouchdb-adapter-leveldb-core"

const hex = value => Buffer.from(value).toString("hex")
const base64 = value => Buffer.from(value).toString("base64")
const decode = (value, asBuffer) => {
  const bytes = Buffer.from(value, "base64")
  return asBuffer === false ? bytes.toString() : bytes
}

/** Keep PouchDB's tested revision engine; SQLite implements only atomic byte storage. */
export function nativePouchAdapter(bridge) {
  class NativeDown extends AbstractLevelDOWN {
    constructor(name) {
      super({ bufferKeys: true, snapshots: true, permanence: true })
      this.name = name
      this.pendingGets = []
      this.readCache = new Map()
      this.generation = 0
    }

    request(operation, options = {}) {
      return bridge.execute({ operation, name: this.name, ...options })
    }

    _open(options, callback) {
      this.request("open", options).then(() => callback(), callback)
    }

    _close(callback) {
      this.invalidate()
      this.request("close").then(() => callback(), callback)
    }

    invalidate() {
      this.generation++
      this.readCache.clear()
    }

    async prefetch(keys) {
      if (!keys.length) return
      const generation = this.generation
      const result = await this.request("getMany", { keys })
      // A write submitted while this read was in flight must not resurrect old cache entries.
      if (generation !== this.generation) return
      keys.forEach((key, index) => {
        if (result.values[index] !== null) this.readCache.set(key, result.values[index])
      })
      while (this.readCache.size > 512) this.readCache.delete(this.readCache.keys().next().value)
    }

    _get(key, options, callback) {
      const cached = this.readCache.get(hex(key))
      if (cached !== undefined) return queueMicrotask(() => callback(null, decode(cached, options.asBuffer)))
      this.pendingGets.push({ key: hex(key), options, callback })
      if (this.pendingGets.length !== 1) return
      queueMicrotask(() => {
        const reads = this.pendingGets.splice(0)
        this.request("getMany", { keys: reads.map(read => read.key) }).then(result => {
          reads.forEach((read, index) => {
            const value = result.values[index]
            if (value === null) read.callback(Object.assign(new Error("NotFound"), { notFound: true, status: 404 }))
            else read.callback(null, decode(value, read.options.asBuffer))
          })
        }, error => reads.forEach(read => read.callback(error)))
      })
    }

    _put(key, value, options, callback) {
      this._batch([{ type: "put", key, value }], options, callback)
    }

    _del(key, options, callback) {
      this._batch([{ type: "del", key }], options, callback)
    }

    _batch(operations, _options, callback) {
      this.invalidate()
      this.request("batch", { operations: operations.map(op => ({
        type: op.type, key: hex(op.key), ...(op.type === "put" ? { value: base64(op.value) } : {})
      })) }).then(() => { this.invalidate(); callback() }, error => { this.invalidate(); callback(error) })
    }

    _iterator(options) {
      return new NativeIterator(this, options)
    }
  }

  function nativeSQLite(name) { return new NativeDown(name) }
  nativeSQLite.destroy = (name, callback) => {
    bridge.execute({ operation: "destroy", name }).then(() => callback(), callback)
  }
  function NativePouch(options, callback) {
    LevelPouch.call(this, { ...options, db: nativeSQLite }, callback)
  }
  NativePouch.valid = () => true
  NativePouch.use_prefix = false
  return PouchDB => PouchDB.adapter("native-sqlite", NativePouch, false)
}

class NativeIterator extends AbstractIterator {
  constructor(db, options) {
    super(db)
    this.options = options
    this.rows = []
    this.done = false
    const range = { reverse: options.reverse, limit: options.limit, values: options.values }
    for (const bound of ["gt", "gte", "lt", "lte"]) {
      if (options[bound] !== undefined) range[bound] = hex(options[bound])
    }
    // Open eagerly: iteration observes a snapshot from its creation, not its first next().
    this.opened = db.request("iteratorOpen", range).then(opened => {
      if (opened.rows) { this.rows = opened.rows; this.done = true }
      return opened
    })
    this.opened.catch(() => {})
  }

  _next(callback) {
    const next = async () => {
      const { iterator } = await this.opened
      if (!this.rows.length && !this.done) {
        const page = await this.db.request("iteratorNext", { iterator })
        this.rows = page.rows
        this.done = page.done
        // PouchDB 9 follows each sequence row with a metadata read, and each
        // allDocs metadata row with a winning-body read. Fetch one bounded page
        // together rather than crossing the native bridge once per document.
        const keys = []
        for (const row of this.rows) {
          if (row.value === undefined) continue
          const key = Buffer.from(row.key, "hex").toString()
          if (key.startsWith("ÿby-sequenceÿ")) {
            const doc = JSON.parse(decode(row.value, false))
            if (doc._id) keys.push(hex("ÿdocument-storeÿ" + doc._id))
          } else if (key.startsWith("ÿdocument-storeÿ")) {
            const metadata = JSON.parse(decode(row.value, false))
            const seq = metadata.rev_map?.[metadata.winningRev]
            if (seq !== undefined) keys.push(hex("ÿby-sequenceÿ" + String(seq).padStart(16, "0")))
          }
        }
        await this.db.prefetch(keys)
      }
      const row = this.rows.shift()
      if (!row) return callback()
      const key = Buffer.from(row.key, "hex")
      callback(null, this.options.keyAsBuffer === false ? key.toString() : key,
        this.options.values === false ? undefined : decode(row.value, this.options.valueAsBuffer))
    }
    next().catch(callback)
  }

  _end(callback) {
    this.opened.then(({ iterator }) => iterator === null ? undefined : this.db.request("iteratorEnd", { iterator })).then(() => callback(), callback)
  }
}
