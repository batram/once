import { promises as fs } from "node:fs"
import path from "node:path"
import { BrowserExtensionSyncDocument, readBrowserExtensionSync } from "@once/core"
import { ElectronManagedExtension, ElectronExtensionPreview } from "@once/platform-electron/bridge"
import { ExtensionCandidate, prepareExtension } from "./ExtensionPackage"
import { LoadedExtension, loadUnpackedExtension } from "./LoadedExtension"
import { ExtensionHost } from "./ExtensionHost"
import { extensionUrl } from "./ExtensionScheme"

interface Installed {
  directory: string
  enabled: boolean
  bundled: boolean
  source: string
  error?: string
}

interface ManagerRuntime {
  load(directory: string, id?: string): Promise<LoadedExtension>
  unload(host: string): Promise<void>
  host(id: string): ExtensionHost | undefined
  changed(): void
}

/** Device-local installation state. Sync never installs or enables executable code. */
export class ExtensionManager {
  private entries: Record<string, Installed> = Object.create(null)
  private readonly candidates = new Map<string, ExtensionCandidate>()
  private queue: Promise<unknown> = Promise.resolve()
  private initialized: Promise<void> | undefined
  private sync: BrowserExtensionSyncDocument = { version: 1, extensions: {} }
  private applying = false
  private syncTimer: NodeJS.Timeout | undefined
  onSyncChanged: ((document: BrowserExtensionSyncDocument) => void) | undefined

  constructor(private readonly root: string, private readonly runtime: ManagerRuntime) {}

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work)
    this.queue = next.catch(() => undefined)
    return next
  }

  private initialize(): Promise<void> {
    this.initialized ??= (async () => {
      try {
        const value = JSON.parse(await fs.readFile(path.join(this.root, "installed.json"), "utf8"))
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid extension catalog")
        this.entries = Object.assign(Object.create(null), value)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
    })()
    return this.initialized
  }

  private async persist(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true })
    const file = path.join(this.root, "installed.json")
    await fs.writeFile(`${file}.tmp`, JSON.stringify(this.entries), "utf8")
    await fs.rename(`${file}.tmp`, file)
    this.runtime.changed()
  }

  async restore(bundles: { id: string; directory: string; present: boolean }[]): Promise<void> {
    await this.serial(async () => {
      await this.initialize()
      for (const bundle of bundles) {
        if (!bundle.present) continue
        const previous = this.entries[bundle.id]
        this.entries[bundle.id] = { directory: bundle.directory, enabled: previous?.enabled ?? true, bundled: true, source: "Included with Once" }
      }
      for (const [id, entry] of Object.entries(this.entries)) {
        if (!entry.enabled) continue
        try { await this.runtime.load(entry.directory, id); delete entry.error }
        catch (error) { entry.error = String(error) }
      }
      await this.persist()
      await this.prunePackages()
    })
  }

  async list(): Promise<ElectronManagedExtension[]> {
    await this.initialize()
    await this.queue
    return Promise.all(Object.entries(this.entries).map(async ([id, entry]) => {
      try {
        const extension = await loadUnpackedExtension(entry.directory, "en")
        return { id, host: extension.host, name: extension.name, version: extension.manifest.version,
          description: extension.description, enabled: entry.enabled, running: !!this.runtime.host(id),
          bundled: entry.bundled, source: entry.source, error: entry.error,
          hasOptions: !!extension.manifest.optionsUi, hasPopup: !!extension.manifest.browserAction?.defaultPopup,
          permissions: [...extension.manifest.permissions, ...extension.manifest.hostPermissions],
          warnings: compatibilityWarnings(extension) }
      } catch (error) {
        return { id, host: "", name: id, version: "", description: "", enabled: entry.enabled,
          running: false, bundled: entry.bundled, source: entry.source, error: String(error),
          hasOptions: false, hasPopup: false, permissions: [], warnings: [] }
      }
    }))
  }

  preview(source: string, file?: string): Promise<ElectronExtensionPreview> {
    return this.serial(async () => {
      await this.initialize()
      for (const candidate of this.candidates.values()) await fs.rm(candidate.extension.directory, { recursive: true, force: true })
      this.candidates.clear()
      const candidate = await prepareExtension(this.root, source, file)
      if (this.entries[candidate.extension.id]?.bundled) {
        await fs.rm(candidate.extension.directory, { recursive: true, force: true })
        throw new Error("Bundled extensions are updated with Once")
      }
      this.candidates.set(candidate.token, candidate)
      const extension = candidate.extension
      return { token: candidate.token, id: extension.id, name: extension.name,
        version: extension.manifest.version, description: extension.description, source: candidate.source,
        permissions: [...extension.manifest.permissions, ...extension.manifest.hostPermissions],
        warnings: compatibilityWarnings(extension), update: !!this.entries[extension.id] }
    })
  }

  install(token: string): Promise<void> {
    return this.serial(async () => {
      const candidate = this.candidates.get(token)
      if (!candidate) throw new Error("This preview has expired. Review the extension again.")
      const { extension } = candidate
      const previous = this.entries[extension.id]
      const entry: Installed = { directory: extension.directory, enabled: previous?.enabled ?? true,
        bundled: false, source: candidate.source }
      try {
        await this.captureNow()
        if (entry.enabled) await this.runtime.load(entry.directory, extension.id)
        this.entries[extension.id] = entry
        await this.persist()
        this.candidates.delete(token)
        const host = this.runtime.host(extension.id)
        host?.contexts.emit("runtime", "onInstalled", [{ reason: previous ? "update" : "install" }])
        await this.prunePackages()
      } catch (error) {
        await this.runtime.unload(extension.host)
        if (previous) {
          this.entries[extension.id] = previous
          if (previous.enabled) await this.runtime.load(previous.directory, extension.id)
        } else Reflect.deleteProperty(this.entries, extension.id)
        throw error
      }
    })
  }

  setEnabled(id: string, enabled: boolean): Promise<void> {
    return this.serial(async () => {
      const entry = this.entries[id]
      if (!entry || typeof enabled !== "boolean") throw new Error("Unknown extension or invalid enabled state")
      const previous = entry.enabled
      try {
        await this.captureNow()
        if (enabled) await this.runtime.load(entry.directory, id)
        else {
          const host = this.runtime.host(id)
          if (host) await this.runtime.unload(host.extension.host)
        }
        entry.enabled = enabled
        delete entry.error
        await this.persist()
      } catch (error) { entry.enabled = previous; entry.error = String(error); this.runtime.changed(); throw error }
    })
  }

  remove(id: string): Promise<void> {
    return this.serial(async () => {
      const entry = this.entries[id]
      if (!entry || entry.bundled) throw new Error("Bundled extensions can be disabled, but not removed")
      const host = this.runtime.host(id)
      await this.captureNow()
      if (host) await this.runtime.unload(host.extension.host)
      Reflect.deleteProperty(this.entries, id)
      try { await this.persist() } catch (error) { this.entries[id] = entry; throw error }
      // Keep extension data so an explicit reinstall can recover its settings.
      await this.prunePackages()
    })
  }

  /** Only generated package directories, after the catalog has been committed. */
  private async prunePackages(): Promise<void> {
    const root = path.join(this.root, "packages")
    const retained = new Set([...Object.values(this.entries).map(entry => path.resolve(entry.directory)),
      ...[...this.candidates.values()].map(candidate => path.resolve(candidate.extension.directory))])
    try {
      for (const name of await fs.readdir(root)) {
        if (!/^[a-f0-9-]{36}$/.test(name)) continue
        const directory = path.resolve(root, name)
        if (!retained.has(directory)) await fs.rm(directory, { recursive: true, force: true })
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error("Could not prune old extension packages", error)
    }
  }

  async openOptions(id: string): Promise<void> {
    const host = this.requireHost(id)
    const page = host.extension.manifest.optionsUi?.page ?? host.extension.manifest.browserAction?.defaultPopup
    if (!page) throw new Error("This extension does not provide a settings page")
    await host.hooks.createTab(extensionUrl(host.extension.host, page), true)
  }

  async storage(id: string): Promise<{ local: Record<string, unknown>; sync: Record<string, unknown> }> {
    const host = this.requireHost(id)
    return { local: await host.storage.get(null), sync: await host.syncStorage.get(null) }
  }

  private requireHost(id: string): ExtensionHost {
    const host = this.runtime.host(id)
    if (!host) throw new Error("Enable the extension to access its settings")
    return host
  }

  async watch(host: ExtensionHost): Promise<void> {
    await this.applyHost(host)
    const changed = () => {
      if (this.applying) return
      if (this.syncTimer) clearTimeout(this.syncTimer)
      this.syncTimer = setTimeout(() => { void this.capture().catch(console.error) }, 300)
    }
    host.storage.onChanged(changed)
    host.syncStorage.onChanged(changed)
  }

  applySync(document: BrowserExtensionSyncDocument): Promise<void> {
    return this.serial(async () => {
      this.sync = readBrowserExtensionSync(document)
      for (const id of Object.keys(this.sync.extensions)) {
        const host = this.runtime.host(id)
        if (host) await this.applyHost(host)
      }
    })
  }

  private async applyHost(host: ExtensionHost): Promise<void> {
    const entry = this.sync.extensions[host.extension.id]
    if (!entry) return
    this.applying = true
    try {
      for (const area of ["local", "sync"] as const) {
        const storage = area === "local" ? host.storage : host.syncStorage
        const removed = entry[area].filter(key => !Object.hasOwn(entry.values[area], key))
        const changes = { ...await storage.remove(removed), ...await storage.set(entry.values[area]) }
        if (Object.keys(changes).length) {
          host.contexts.emit("storage", "onChanged", [changes, area])
          host.contexts.emit(`storage.${area}`, "onChanged", [changes])
        }
      }
    } finally { this.applying = false }
  }

  private capture(): Promise<void> {
    return this.serial(() => this.captureNow())
  }

  private async captureNow(): Promise<void> {
    const next = structuredClone(this.sync)
    for (const [id, entry] of Object.entries(next.extensions)) {
      const host = this.runtime.host(id)
      if (!host) continue
      entry.values = { local: await host.storage.get(entry.local), sync: await host.syncStorage.get(entry.sync) }
    }
    if (JSON.stringify(next) === JSON.stringify(this.sync)) return
    this.sync = next
    this.onSyncChanged?.(next)
  }
}

function compatibilityWarnings(extension: LoadedExtension): string[] {
  const warnings = ["Firefox Manifest V2 compatibility runtime. Some browser APIs are limited; reload open pages after enabling or disabling."]
  const limited = ["theme", "commands", "notifications", "contextMenus", "menus", "nativeMessaging", "downloads", "bookmarks", "history"]
    .filter(permission => extension.manifest.permissions.has(permission))
  if (limited.length) warnings.push(`Limited or unavailable features: ${limited.join(", ")}.`)
  return warnings
}
