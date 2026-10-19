import { ApiHost } from "./ExtensionApi"
import { applySettingsToExtension, VIOLENTMONKEY_ID } from "./extensionSettingsApply"
import { AdoptedExtensionSettings, ExtensionSettings, SettingsStatus } from "./managementTypes"

/** Settings application and dashboard observation, independently serialized per extension. */
export class ExtensionSettingsCoordinator {
  private settings: ExtensionSettings | null = null
  private readonly applications = new WeakMap<ApiHost, Promise<void>>()
  private readonly revisions = new WeakMap<ApiHost, number>()
  private readonly statuses = new WeakMap<ApiHost, SettingsStatus | undefined>()
  private readonly timers = new Map<ApiHost, ReturnType<typeof setTimeout>>()
  private readonly applying = new WeakSet<ApiHost>()
  private readonly adopted = new Set<(settings: AdoptedExtensionSettings) => void>()

  constructor(
    private readonly hosts: () => Iterable<ApiHost>,
    private readonly changed: () => void,
    private readonly apply = applySettingsToExtension
  ) {}

  status(host: ApiHost): SettingsStatus | undefined { return this.statuses.get(host) }
  onAdopted(listener: (settings: AdoptedExtensionSettings) => void): void { this.adopted.add(listener) }

  watch(host: ApiHost): void {
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

  forget(host: ApiHost): void {
    const timer = this.timers.get(host)
    if (timer) clearTimeout(timer)
    this.timers.delete(host)
    this.revisions.set(host, (this.revisions.get(host) ?? 0) + 1)
  }

  async applySettings(settings: ExtensionSettings): Promise<void> {
    if (!settings || !Array.isArray(settings.filterLists?.lists) || !Array.isArray(settings.userscripts?.scripts)) {
      throw new Error("Invalid extension settings")
    }
    this.settings = settings
    await Promise.all([...this.hosts()].map(host => this.applyTo(host)))
  }

  applyTo(host: ApiHost): Promise<void> {
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
        const adopted = await this.apply(host, settings)
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
