import { app, safeStorage } from "electron"
import { DEFAULT_CACHE_MINUTES } from "@once/core"
import { promises as fs } from "fs"
import * as path from "path"

interface StoredSettings {
  encryptedSyncUrl?: string
  cacheTime?: number
  /** Source tokens and the like, each encrypted like the sync URL. */
  encryptedSecrets?: Record<string, string>
  /** Full accessibility tree for screen readers; see main.ts. */
  accessibility?: boolean
}

export class SecureSettings {
  private readonly filePath = path.join(
    app.getPath("userData"),
    "once-v2-settings.json"
  )

  async getSyncUrl(): Promise<string> {
    const settings = await this.read()
    if (!settings.encryptedSyncUrl) return ""
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("Secure credential storage is unavailable")
    }

    return safeStorage.decryptString(
      Buffer.from(settings.encryptedSyncUrl, "base64")
    )
  }

  async setSyncUrl(syncUrl: string): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("Secure credential storage is unavailable")
    }

    const settings = await this.read()
    settings.encryptedSyncUrl = safeStorage
      .encryptString(syncUrl)
      .toString("base64")
    await this.write(settings)
  }

  async getSecret(key: string): Promise<string> {
    const settings = await this.read()
    const encrypted = settings.encryptedSecrets?.[key]
    if (!encrypted) return ""
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("Secure credential storage is unavailable")
    }
    return safeStorage.decryptString(Buffer.from(encrypted, "base64"))
  }

  async setSecret(key: string, value: string): Promise<void> {
    if (value && !safeStorage.isEncryptionAvailable()) {
      throw new Error("Secure credential storage is unavailable")
    }
    const settings = await this.read()
    const kept = Object.entries(settings.encryptedSecrets ?? {})
      .filter(([name]) => name !== key)
    if (value) kept.push([key, safeStorage.encryptString(value).toString("base64")])
    settings.encryptedSecrets = Object.fromEntries(kept)
    await this.write(settings)
  }

  async getCacheTime(): Promise<number> {
    const settings = await this.read()
    const cacheTime = settings.cacheTime
    return typeof cacheTime === "number" && Number.isFinite(cacheTime)
      ? cacheTime
      : DEFAULT_CACHE_MINUTES
  }

  async setCacheTime(cacheTime: string): Promise<void> {
    const parsed = Number.parseInt(cacheTime, 10)
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new Error("Cache time must be a non-negative integer")
    }

    const settings = await this.read()
    settings.cacheTime = parsed
    await this.write(settings)
  }

  async getAccessibility(): Promise<boolean> {
    return (await this.read()).accessibility === true
  }

  async setAccessibility(enabled: boolean): Promise<void> {
    if (typeof enabled !== "boolean") {
      throw new Error("Accessibility must be a boolean")
    }
    const settings = await this.read()
    settings.accessibility = enabled
    await this.write(settings)
  }

  private async read(): Promise<StoredSettings> {
    try {
      return JSON.parse(await fs.readFile(this.filePath, "utf8"))
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return {}
      throw error
    }
  }

  private async write(settings: StoredSettings): Promise<void> {
    const temporaryPath = `${this.filePath}.tmp`
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    await fs.writeFile(temporaryPath, JSON.stringify(settings, null, 2), "utf8")
    await fs.rename(temporaryPath, this.filePath)
  }
}
