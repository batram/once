import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs"
import path from "node:path"
import { readAddonManifest } from "@once/core"
import { DevAddon, readDevAddons, readDevAddon, watchDevAddons } from "./devAddons"

/** User-selected directories are device-local, including in packaged builds. */
export class LocalAddonDirectories {
  readonly directories: string[] = []
  private selected: string[] = []
  private stopWatching: () => void = () => undefined
  constructor(private readonly file: string, private readonly environment: string[], private readonly changed: () => void) {
    if (existsSync(file)) {
      const stored: unknown = JSON.parse(readFileSync(file, "utf8"))
      if (!Array.isArray(stored) || stored.length > 16 || !stored.every(item => typeof item === "string" && path.isAbsolute(item))) throw new Error("Invalid local addon directory list")
      this.selected = stored
    }
    this.refresh()
  }

  list(): (DevAddon & { removable: boolean })[] {
    return readDevAddons(this.directories).map(entry => ({ ...entry, removable: this.selected.includes(entry.directory) }))
  }

  add(directory: string): void {
    const resolved = path.resolve(directory)
    const entry = readDevAddon(resolved, 0)
    if (entry.error) throw new Error(entry.error)
    const read = readAddonManifest(entry.manifest)
    if (!read.ok) throw new Error(read.reports.map(report => `${report.path} ${report.message}`).join("; "))
    const duplicate = this.list().find(item => {
      const current = readAddonManifest(item.manifest)
      return current.ok && current.manifest.id === read.manifest.id && item.directory !== resolved
    })
    if (duplicate) throw new Error("An addon with this ID is already loaded from another directory")
    if (this.directories.includes(resolved)) return
    if (this.selected.length >= 16) throw new Error("At most 16 local addon directories can be loaded")
    this.save([...this.selected, resolved])
  }

  remove(directory: string): void {
    if (!this.selected.includes(directory)) throw new Error("This directory was not loaded with the picker")
    this.save(this.selected.filter(item => item !== directory))
  }

  dispose(): void { this.stopWatching() }

  private save(directories: string[]): void {
    mkdirSync(path.dirname(this.file), { recursive: true })
    writeFileSync(`${this.file}.tmp`, JSON.stringify(directories), "utf8")
    renameSync(`${this.file}.tmp`, this.file)
    this.selected = directories
    this.refresh()
    this.changed()
  }

  private refresh(): void {
    this.stopWatching()
    this.directories.splice(0, this.directories.length, ...new Set([...this.environment, ...this.selected]))
    this.stopWatching = watchDevAddons(this.directories, this.changed)
  }
}
