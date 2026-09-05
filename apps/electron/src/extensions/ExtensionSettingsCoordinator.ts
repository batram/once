import { ElectronExtensionInfo, ElectronExtensionSettings } from "@once/platform-electron/bridge"
import { ExtensionHost } from "./ExtensionHost"
import { AdoptedExtensionSettings, applySettingsToExtension, VIOLENTMONKEY_ID } from "./extensionSettingsApply"

/** Settings application and dashboard observation, independently serialized per extension. */
export class ExtensionSettingsCoordinator {
  private settings: ElectronExtensionSettings | null = null
  private readonly applications = new WeakMap<ExtensionHost, Promise<void>>()
  private readonly revisions = new WeakMap<ExtensionHost, number>()
  private readonly statuses = new WeakMap<ExtensionHost, ElectronExtensionInfo["settingsStatus"]>()
  private readonly timers = new Map<ExtensionHost, NodeJS.Timeout>()
  private readonly applying = new WeakSet<ExtensionHost>()
  private readonly adopted = new Set<(settings: AdoptedExtensionSettings) => void>()

  constructor(
    private readonly storageRoot: string,
    private readonly hosts: () => Iterable<ExtensionHost>,
    private readonly changed: () => void,
    private readonly apply = applySettingsToExtension
  ) {}

  status(host: ExtensionHost): ElectronExtensionInfo["settingsStatus"] { return this.statuses.get(host) }
  onAdopted(listener: (settings: AdoptedExtensionSettings) => void): void { this.adopted.add(listener) }

  watch(host: ExtensionHost): void {
    if (host.extension.id !== VIOLENTMONKEY_ID) return
    host.storage.onChanged(() => {
      if (this.applying.has(host)) return
      const previous = this.timers.get(host)
      if (previous) clearTimeout(previous)
      this.timers.set(host, setTimeout(() => {
        this.timers.delete(host)
        void this.applyTo(host)
      }, 500))
    })
  }

  forget(host: ExtensionHost): void {
    const timer = this.timers.get(host)
    if (timer) clearTimeout(timer)
    this.timers.delete(host)
    this.revisions.set(host, (this.revisions.get(host) ?? 0) + 1)
  }

  async applySettings(settings: ElectronExtensionSettings): Promise<void> {
    if (!settings || !Array.isArray(settings.filterLists?.lists) || !Array.isArray(settings.userscripts?.scripts)) {
      throw new Error("Invalid extension settings")
    }
    this.settings = settings
    await Promise.all([...this.hosts()].map(host => this.applyTo(host)))
  }

  applyTo(host: ExtensionHost): Promise<void> {
    const settings = this.settings
    if (!settings) return Promise.resolve()
    const revision = (this.revisions.get(host) ?? 0) + 1
    this.revisions.set(host, revision)
    const current = () => [...this.hosts()].includes(host) && this.revisions.get(host) === revision
    const work = (this.applications.get(host) ?? Promise.resolve()).then(async () => {
      if (!current()) return
      this.statuses.set(host, { state: "applying" })
      this.applying.add(host)
      this.changed()
      try {
        const adopted = await this.apply(host, settings, this.storageRoot)
        if (!current()) return
        this.statuses.set(host, { state: "applied" })
        if (Object.keys(adopted).length > 0) {
          if (adopted.userscripts) this.settings = { ...settings, ...adopted }
          for (const listener of this.adopted) listener(adopted)
        }
      } catch (error) {
        if (current()) this.statuses.set(host, { state: "failed", error: String(error) })
        console.error(`Settings could not be handed to ${host.extension.name}`, error)
      } finally {
        this.applying.delete(host)
        this.changed()
      }
    })
    this.applications.set(host, work.catch(() => undefined))
    return work
  }
}
