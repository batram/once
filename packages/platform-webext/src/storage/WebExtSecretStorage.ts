/**
 * Source tokens, in `storage.local` rather than the `storage.sync` area the
 * sync URL uses: the browser would otherwise carry them to every profile the
 * user signs into, and a token is meant to stay on the device it was typed on.
 */
export class WebExtSecretStorage {
  constructor(private browserApi: typeof browser = browser) {}

  async get(key: string): Promise<string> {
    const name = this.name(key)
    const data = await this.browserApi.storage.local.get(name)
    return typeof data?.[name] === "string" ? data[name] : ""
  }

  async set(key: string, value: string): Promise<void> {
    const name = this.name(key)
    if (value) await this.browserApi.storage.local.set({ [name]: value })
    else await this.browserApi.storage.local.remove(name)
  }

  onChanged(handler: () => void): () => void {
    const listener = (changes: Record<string, unknown>, area: string) => {
      if (area === "local" && Object.keys(changes).some((key) => key.startsWith("secret:"))) handler()
    }
    this.browserApi.storage.onChanged.addListener(listener)
    return () => this.browserApi.storage.onChanged.removeListener(listener)
  }

  private name(key: string): string {
    return `secret:${key}`
  }
}
