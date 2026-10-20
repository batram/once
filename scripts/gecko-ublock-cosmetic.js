// A cache-only representation. Runtime lookups read the packed tables lazily;
// the first edit materializes a normal Map. No filter is omitted or deferred.
function packColumn(values) {
  if (values.length && typeof values[0] === "number") {
    if (!values.every(value => typeof value === "number" && Number.isFinite(value))) throw new TypeError("Bad numeric cache column")
    return Float64Array.from(values)
  }
  const offsets = new Uint32Array(values.length + 1)
  for (let i = 0; i < values.length; i++) {
    if (typeof values[i] !== "string") throw new TypeError("Bad string cache column")
    offsets[i + 1] = offsets[i] + values[i].length
  }
  return { text: values.join(""), offsets }
}

function columnValue(column, index) {
  return column instanceof Float64Array ? column[index] : column.text.slice(column.offsets[index], column.offsets[index + 1])
}

function validateColumn(column, length) {
  if (column instanceof Float64Array) {
    if (column.length !== length || !column.every(Number.isFinite)) throw new TypeError("Bad numeric cache column")
    return
  }
  if (!column || typeof column.text !== "string" || !(column.offsets instanceof Uint32Array) ||
      column.offsets.length !== length + 1 || column.offsets[0] !== 0 || column.offsets.at(-1) !== column.text.length) {
    throw new TypeError("Bad string cache column")
  }
  for (let i = 1; i < column.offsets.length; i++) {
    if (column.offsets[i] < column.offsets[i - 1]) throw new TypeError("Bad string cache column")
  }
}

class PackedFilterIndex {
  #packed
  #mutable = null
  constructor(packed) {
    if (packed?.format !== "once-index-1" || !Number.isSafeInteger(packed.size) || packed.size < 0) throw new TypeError("Bad cache index")
    validateColumn(packed.keys, packed.size)
    validateColumn(packed.values, packed.size)
    let previous
    for (let i = 0; i < packed.size; i++) {
      const key = columnValue(packed.keys, i)
      if (i && !(previous < key)) throw new TypeError("Unsorted cache index")
      previous = key
    }
    this.#packed = packed
  }
  get size() { return this.#mutable?.size ?? this.#packed.size }
  get(key) {
    if (this.#mutable) return this.#mutable.get(key)
    const { keys, values, size } = this.#packed
    if (typeof key !== (keys instanceof Float64Array ? "number" : "string")) return undefined
    let lo = 0, hi = size
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      const candidate = columnValue(keys, mid)
      if (candidate === key) return columnValue(values, mid)
      if (candidate < key) lo = mid + 1
      else hi = mid
    }
    return undefined
  }
  has(key) { return this.get(key) !== undefined }
  set(key, value) {
    if (!this.#mutable) {
      this.#mutable = new Map(this.entries())
      this.#packed = null
    }
    this.#mutable.set(key, value)
    return this
  }
  clear() { this.#mutable = new Map(); this.#packed = null }
  *entries() {
    if (this.#mutable) { yield* this.#mutable.entries(); return }
    for (let i = 0; i < this.#packed.size; i++) yield [columnValue(this.#packed.keys, i), columnValue(this.#packed.values, i)]
  }
  *values() { for (const [, value] of this.entries()) yield value }
  [Symbol.iterator]() { return this.entries() }
  packed() { return this.#mutable ? packFilterIndex(this.#mutable) : this.#packed }
}

function packFilterIndex(map) {
  if (map instanceof PackedFilterIndex) return map.packed()
  if (!(map instanceof Map)) throw new TypeError("Bad cache map")
  const entries = [...map].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
  return { format: "once-index-1", size: entries.length, keys: packColumn(entries.map(entry => entry[0])), values: packColumn(entries.map(entry => entry[1])) }
}

function unpackFilterIndex(value) {
  return value instanceof Map ? value : new PackedFilterIndex(value)
}

function packHostnameSelfie(selfie) {
  const { strSlots, linkedLists, ...rest } = selfie
  const strings = packColumn(strSlots)
  for (const key of ["hostnameToStringListMap", "matcherMap", "hostnameToMatcherListMap"]) rest[key] = packFilterIndex(rest[key])
  return { ...rest, VERSION: "once-packed-1", text: strings.text, offsets: strings.offsets, linkedLists: new Uint32Array(linkedLists) }
}

function unpackHostnameSelfie(selfie) {
  if (!selfie || typeof selfie !== "object") throw new TypeError("Bad selfie")
  if (selfie.VERSION === 1) return { ...selfie, packedText: null, packedOffsets: null }
  if (selfie.VERSION !== "once-packed-1" || !(selfie.offsets instanceof Uint32Array) || !(selfie.linkedLists instanceof Uint32Array)) throw new TypeError("Bad selfie")
  validateColumn({ text: selfie.text, offsets: selfie.offsets }, selfie.offsets.length - 1)
  if (selfie.offsets.length < 2 || selfie.offsets[1] !== 0 || selfie.linkedLists.length < 2 || selfie.linkedLists.length % 2 !== 0) throw new TypeError("Bad selfie")
  const decoded = { ...selfie, strSlots: new Array(selfie.offsets.length - 1), packedText: selfie.text, packedOffsets: selfie.offsets }
  for (const key of ["hostnameToStringListMap", "matcherMap", "hostnameToMatcherListMap"]) decoded[key] = new PackedFilterIndex(selfie[key])
  return decoded
}

module.exports = { packFilterIndex, unpackFilterIndex, packHostnameSelfie, unpackHostnameSelfie }
