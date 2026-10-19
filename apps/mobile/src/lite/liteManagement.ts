// Installing and managing extensions on Lite: the shared `ExtensionManager`
// over a Java-backed package host, the shell's `extensionCommand` verbs, and
// the catalogue in the shape `@once/platform-mobile`'s `MobileBrowserExtension`
// has. Confirmations are native dialogs Java shows (`ui.confirm`).
//
// Archives are unpacked by Java: `onceLiteFiles.unzip(token, base64)` writes
// the entries into a staging directory `<storageRoot>/packages/.staging/<token>`
// with `java.util.zip`, refusing names that leave it, and answers the entry
// list; each entry's bytes are then read back through `onceLiteFiles.read`
// and written into the final package directory by the shared validation
// code (`files.write`, which refuses to overwrite). A pure-JS inflater was
// not chosen: WebView already ships the decompressor, and Java's copy of
// the archive never has to cross the message channel twice.

import {
  ArchiveEntry,
  ExtensionManager,
  ExtensionPackageHost,
  ExtensionPackageStore,
  ManagedExtension,
  ManagerRuntime,
  amoSourceKind,
  sha256Hex
} from "@once/webext-runtime"
import { JavaChannel, RequestError } from "./javaChannel"
import { FilesInterface, LiteFileReader, decodeBase64 } from "./liteFiles"
import { LiteJsonStore } from "./liteStorage"
import { CatalogEntry, ConfirmParams, ExtensionCommandParams, ExtensionCommandResult, FetchResult, UnzipResult } from "./protocol"

function toBase64(bytes: Uint8Array): string {
  let binary = ""
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

class LitePackageStore implements ExtensionPackageStore {
  constructor(
    private readonly channel: JavaChannel,
    private readonly files: FilesInterface,
    private readonly root: string
  ) {}

  directory(token: string): string {
    return `${this.root}/${token}`
  }

  async mkdir(directory: string, relativePath: string): Promise<void> {
    await this.channel.request("files.mkdir", { directory, path: relativePath })
  }

  async writeFile(directory: string, relativePath: string, data: Uint8Array): Promise<void> {
    await this.channel.request("files.write", { directory, path: relativePath, base64: toBase64(data) })
  }

  async remove(directory: string): Promise<void> {
    await this.channel.request("files.remove", { directory })
  }

  async list(): Promise<{ name: string; directory: string }[]> {
    const result = await this.channel.request<{ entries: string[] }>("files.list", { directory: this.root })
    return (result.entries ?? []).map((name) => ({ name, directory: this.directory(name) }))
  }

  canonical(directory: string): string {
    return directory.replace(/\/+$/, "")
  }

  reader(directory: string): LiteFileReader {
    return new LiteFileReader(this.files, directory)
  }
}

export function litePackageHost(
  channel: JavaChannel,
  files: FilesInterface,
  storageRoot: string,
  locale: () => string
): ExtensionPackageHost {
  const packagesRoot = `${storageRoot}/packages`
  return {
    fetch: async (url) => {
      const result = await channel.request<FetchResult>("package.fetch", { url })
      const body = result.status === 204 || result.status === 304 ? null : decodeBase64(result.bodyBase64) as unknown as BodyInit
      return new Response(body, {
        status: result.status, headers: result.headers
      })
    },
    sha256: async (data) => sha256Hex(data),
    unzip: (archive) => {
      if (typeof files.unzip !== "function") throw new Error("Unpacking archives is not available")
      const token = crypto.randomUUID()
      const staging = `${packagesRoot}/.staging/${token}`
      const result = JSON.parse(files.unzip(token, toBase64(archive))) as UnzipResult
      return result.entries.map((entry): ArchiveEntry => ({
        name: entry.name,
        isDirectory: entry.isDirectory,
        size: entry.size,
        data: () => {
          const raw = files.read(staging, entry.name)
          const parsed = raw === null ? null : JSON.parse(raw) as { base64?: string; text?: string }
          if (parsed?.base64 !== undefined) return decodeBase64(parsed.base64)
          if (parsed?.text !== undefined) return new TextEncoder().encode(parsed.text)
          throw new Error(`${entry.name} is missing from the unpacked archive`)
        }
      }))
    },
    readArchive: async (localFile) => {
      const result = await channel.request<{ base64: string }>("package.readArchive", { file: localFile })
      return decodeBase64(result.base64)
    },
    locale,
    packages: new LitePackageStore(channel, files, packagesRoot)
  }
}

export function catalogEntry(entry: ManagedExtension): CatalogEntry {
  const catalog: CatalogEntry = {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    version: entry.version,
    enabled: entry.enabled,
    bundled: entry.bundled,
    hasOptions: entry.hasOptions,
    hasAction: entry.hasPopup,
    permissions: entry.permissions,
    disabledReason: entry.error ?? ""
  }
  if (entry.icon) catalog.iconDataUrl = entry.icon
  return catalog
}

export interface LiteManagementOptions {
  channel: JavaChannel
  files: FilesInterface
  storageRoot: string
  locale(): string
  runtime: ManagerRuntime
  /** Opens the extension's options page or popup; false when it has none. */
  openOptions(id: string): Promise<boolean>
  openAction(id: string): Promise<boolean>
}

export class LiteManagement {
  readonly manager: ExtensionManager

  constructor(private readonly options: LiteManagementOptions) {
    this.manager = new ExtensionManager({
      catalog: new LiteJsonStore(options.channel, `${options.storageRoot}/manager`),
      packages: litePackageHost(options.channel, options.files, options.storageRoot, options.locale)
    }, options.runtime)
  }

  async catalog(): Promise<CatalogEntry[]> {
    return (await this.manager.list()).map(catalogEntry)
  }

  /** The shell's `extensionCommand`. */
  async command(params: ExtensionCommandParams): Promise<ExtensionCommandResult> {
    switch (params.action) {
      case "list":
        return { extensions: await this.catalog() }
      case "install":
        if (typeof params.source !== "string") throw new Error("A source is required")
        return this.installFrom(params.source)
      case "chooseFile": {
        const file = params.file ?? (await this.options.channel.request<{ file?: string }>("ui.pickFile", {})).file
        if (!file) return { cancelled: true }
        return this.installFrom("file", file)
      }
      case "enable":
        await this.manager.setEnabled(requireId(params), params.enabled !== false)
        return { extensions: await this.catalog() }
      case "remove":
        return this.remove(requireId(params))
      case "update":
        return this.update(requireId(params))
      case "options":
        return { noPage: !(await this.options.openOptions(requireId(params))) }
      case "action":
        return { noPage: !(await this.options.openAction(requireId(params))) }
      default:
        throw new Error(`Unknown extension command ${String((params as { action?: unknown }).action)}`)
    }
  }

  private async confirm(params: ConfirmParams): Promise<boolean> {
    const result = await this.options.channel.request<{ confirmed: boolean }>("ui.confirm", params)
    return result.confirmed === true
  }

  private async installFrom(source: string, file?: string): Promise<ExtensionCommandResult> {
    if (!file && amoSourceKind(source) === null) {
      throw new RequestError("Use a Firefox Add-ons page URL, or choose an XPI file.", "INVALID_SOURCE")
    }
    const candidate = await this.manager.preview(source, file)
    const permissions = candidate.permissions.length
      ? candidate.permissions.map((permission) => `• ${permission}`)
      : ["• No additional permissions"]
    const confirmed = await this.confirm({
      title: candidate.update ? "Update extension" : "Install extension",
      message: `${candidate.update ? "Update" : "Add"} ${candidate.name} ${candidate.update ? "in" : "to"} Once?`,
      detail: [candidate.description, `Version ${candidate.version} · ${candidate.source}`, "", "Requested access:", ...permissions, "", ...candidate.warnings]
        .filter((line, index, lines) => line !== "" || lines[index - 1] !== "").join("\n"),
      confirmLabel: candidate.update ? "Update" : "Install",
      cancelLabel: "Cancel"
    })
    if (!confirmed) return { cancelled: true }
    await this.manager.install(candidate.token)
    return { extensions: await this.catalog() }
  }

  private async remove(id: string): Promise<ExtensionCommandResult> {
    const installed = (await this.manager.list()).find((entry) => entry.id === id)
    if (!installed || installed.bundled) throw new Error("This extension cannot be removed")
    const confirmed = await this.confirm({
      title: "Remove extension",
      message: `Remove ${installed.name} from Once?`,
      detail: "Its local settings are kept for a later reinstall.",
      confirmLabel: "Remove",
      cancelLabel: "Cancel"
    })
    if (!confirmed) return { cancelled: true }
    await this.manager.remove(id)
    return { extensions: await this.catalog() }
  }

  private async update(id: string): Promise<ExtensionCommandResult> {
    const installed = (await this.manager.list()).find((entry) => entry.id === id)
    if (!installed) throw new Error("Unknown extension")
    if (installed.bundled) throw new Error("Bundled extensions are updated with Once")
    if (amoSourceKind(installed.source) === null) throw new Error("This extension was installed from a file; choose the new file to update it")
    return this.installFrom(installed.source)
  }
}

function requireId(params: ExtensionCommandParams): string {
  if (typeof params.id !== "string" || !params.id) throw new Error("An extension id is required")
  return params.id
}
