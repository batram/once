// Loads the Once Lite broker sources (TypeScript under apps/mobile/src/lite)
// into Node for the unit tests, and plays Java: a fake `onceLite` port that
// answers the broker's requests from in-memory stores, a fake `onceLiteFiles`
// over directories on disk or in memory, and helpers to send events.
const fs = require("node:fs")
const path = require("node:path")
const Module = require("node:module")
const ts = require("typescript")

const root = path.resolve(__dirname, "../../..")
const liteRoot = path.join(root, "apps/mobile/src/lite")

if (!Module._extensions[".ts"]) {
  Module._extensions[".ts"] = (module, filename) => {
    const source = fs.readFileSync(filename, "utf8")
    const { outputText } = ts.transpileModule(source, {
      fileName: filename,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
    })
    module._compile(outputText, filename)
  }
}

function lite(name) {
  return require(path.join(liteRoot, `${name}.ts`))
}

const TEXT = new Set([".js", ".mjs", ".css", ".json", ".html", ".htm", ".txt", ".xml", ".svg", ".map"])

/** `onceLiteFiles`: directories on disk, in-memory directories, and the bundle stubs. */
function fakeFiles(memory = {}) {
  const bundles = {
    "lite-world-bootstrap.js": "/* world bootstrap */",
    "lite-page-bootstrap.js": "/* page bootstrap */"
  }
  const files = {
    memory,
    read(directory, relativePath) {
      if (directory === "@bundle") return bundles[relativePath] ? JSON.stringify({ text: bundles[relativePath] }) : null
      const entries = memory[directory]
      if (entries) {
        const entry = entries[relativePath]
        if (entry === undefined) return null
        return JSON.stringify(typeof entry === "string" ? { text: entry } : { base64: Buffer.from(entry).toString("base64") })
      }
      const file = path.join(directory, relativePath)
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return null
      const bytes = fs.readFileSync(file)
      return TEXT.has(path.extname(relativePath)) ? JSON.stringify({ text: bytes.toString("utf8") }) : JSON.stringify({ base64: bytes.toString("base64") })
    },
    unzip(token, archiveBase64) {
      const AdmZip = require("adm-zip")
      const zip = new AdmZip(Buffer.from(archiveBase64, "base64"))
      const staging = `/storage/packages/.staging/${token}`
      memory[staging] = {}
      const entries = zip.getEntries().map((entry) => {
        if (!entry.isDirectory) memory[staging][entry.entryName] = entry.getData()
        return { name: entry.entryName, isDirectory: entry.isDirectory, size: entry.header.size }
      })
      return JSON.stringify({ entries })
    }
  }
  return files
}

/**
 * Java's end of `onceLite`. Requests the broker makes are answered by the
 * handlers here; events it sends are recorded; `request`/`event` send to
 * the broker as Java would.
 */
class FakeJava {
  constructor(files) {
    this.files = files
    this.sent = []
    this.events = []
    this.requests = []
    this.stores = new Map()
    this.patches = []
    this.syncAnswers = new Map()
    this.pending = new Map()
    this.waiters = []
    this.nextId = 1
    this.pages = new Map()
    this.cdp = []
    this.handlers = {
      "store.read": ({ directory, name }) => ({ json: this.stores.get(`${directory}/${name}`) ?? null }),
      "store.write": ({ directory, name, json }) => { this.stores.set(`${directory}/${name}`, json) },
      // Java merges a patch into the document on disk: parsed, keys set and removed, written back.
      "store.patch": ({ directory, name, set, remove }) => {
        const key = `${directory}/${name}`
        this.patches.push({ name, set: Object.keys(set), remove })
        const current = this.stores.has(key) ? JSON.parse(this.stores.get(key)) : {}
        for (const [field, json] of Object.entries(set)) current[field] = JSON.parse(json)
        for (const field of remove) Reflect.deleteProperty(current, field)
        this.stores.set(key, JSON.stringify(current))
      },
      "cdp.command": (params) => {
        this.cdp.push(params)
        if (params.method === "Fetch.getResponseBody") return { body: Buffer.from("<html>body</html>").toString("base64"), base64Encoded: true }
        return this.cdpResult?.(params) ?? {}
      },
      "worlds.set": ({ registrations }) => { this.registrations = registrations },
      "sync.set": ({ host, path, body }) => { this.syncAnswers.set(`${host}${path}`, body) },
      "page.open": (params) => { this.pages.set(params.pageId, params) },
      "page.close": ({ pageId }) => { this.pages.delete(pageId) },
      "page.post": () => undefined,
      "page.resize": () => undefined,
      "ui.confirm": () => ({ confirmed: this.confirm ?? true }),
      "ui.pickFile": () => ({ file: this.pickedFile }),
      "files.mkdir": ({ directory, path: relative }) => { (this.files.memory[directory] ??= {}); void relative },
      "files.write": ({ directory, path: relative, base64 }) => {
        const entries = this.files.memory[directory] ??= {}
        if (entries[relative] !== undefined) throw new Error(`${relative} exists`)
        const bytes = Buffer.from(base64, "base64")
        entries[relative] = TEXT.has(path.extname(relative)) ? bytes.toString("utf8") : bytes
      },
      "files.remove": ({ directory }) => { Reflect.deleteProperty(this.files.memory, directory) },
      "files.list": ({ directory }) => ({
        entries: Object.keys(this.files.memory).filter((key) => key.startsWith(`${directory}/`) && !key.includes("/.staging/"))
          .map((key) => key.slice(directory.length + 1).split("/")[0])
      }),
      "package.readArchive": ({ file }) => ({ base64: this.archives[file].toString("base64") }),
      "tab.create": ({ url }) => {
        const tabId = this.nextTab ??= 100
        this.nextTab += 1
        this.event("tab.changed", { tabId, generation: 1, url, title: "", active: true, index: 0, status: "loading", audible: false, muted: false })
        return { tabId }
      },
      "tab.update": () => undefined,
      "tab.remove": () => undefined,
      "tab.reload": () => undefined,
      "cookies.get": () => ({ cookies: this.cookies ?? [] }),
      "cookies.set": () => undefined,
      "cookies.remove": () => undefined
    }
    this.archives = {}
    this.port = {
      onmessage: null,
      postMessage: (text) => this.receive(JSON.parse(text))
    }
  }

  receive(envelope) {
    this.sent.push(envelope)
    for (const waiter of [...this.waiters]) waiter(envelope)
    if (envelope.type === "event") this.events.push(envelope)
    else if (envelope.type === "request") {
      this.requests.push(envelope)
      void this.answer(envelope)
    } else if (envelope.type === "response") {
      const pending = this.pending.get(envelope.id)
      this.pending.delete(envelope.id)
      if (!pending) return
      if (envelope.error !== undefined) pending.reject(Object.assign(new Error(envelope.error), { code: envelope.code }))
      else pending.resolve(envelope.result)
    }
  }

  async answer(envelope) {
    const handler = this.handlers[envelope.method]
    let response
    try {
      if (!handler) throw new Error(`FakeJava has no ${envelope.method}`)
      response = { type: "response", id: envelope.id, result: await handler(envelope.params) ?? null }
    } catch (error) {
      response = { type: "response", id: envelope.id, error: error.message }
    }
    // Java answers from another thread; never synchronously.
    await new Promise((resolve) => setImmediate(resolve))
    this.port.onmessage({ data: JSON.stringify(response) })
  }

  request(method, params) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      this.pending.set(id, { resolve, reject })
      this.port.onmessage({ data: JSON.stringify({ type: "request", id, method, params }) })
    })
  }

  event(event, params) {
    this.port.onmessage({ data: JSON.stringify({ type: "event", event, params }) })
  }

  cdpEvent(targetId, method, params) {
    this.event("cdp.event", { targetId, method, params })
  }

  /** Resolves with the next message the broker sends that `predicate` accepts. */
  next(predicate, timeoutMs = 3000) {
    const earlier = this.sent.find(predicate)
    if (earlier) return Promise.resolve(earlier)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1)
        reject(new Error("Timed out waiting for the broker"))
      }, timeoutMs)
      const waiter = (envelope) => {
        if (!predicate(envelope)) return
        clearTimeout(timer)
        this.waiters.splice(this.waiters.indexOf(waiter), 1)
        resolve(envelope)
      }
      this.waiters.push(waiter)
    })
  }

  /** The next `page.post` carrying an API event of `api.event` to a page. */
  nextPageEvent(pageId, api, event) {
    return this.next((envelope) => envelope.type === "request" && envelope.method === "page.post" &&
      envelope.params.pageId === pageId && envelope.params.message.type === "event" &&
      envelope.params.message.message.api === api && envelope.params.message.message.event === event)
  }

  nextCdp(method) {
    return this.next((envelope) => envelope.type === "request" && envelope.method === "cdp.command" && envelope.params.method === method)
  }

  /** What a page sends: `page.message` with Java's framing. */
  pageMessage(pageId, message, extra = {}) {
    this.event("page.message", { pageId, frameId: 0, mainFrame: true, url: this.pages.get(pageId)?.url ?? extra.url, message, ...extra })
  }

  /** Marks a message as consumed so `next` does not find it again. */
  forget(envelope) {
    const index = this.sent.indexOf(envelope)
    if (index >= 0) this.sent.splice(index, 1)
  }
}

module.exports = { lite, fakeFiles, FakeJava, root, liteRoot }
