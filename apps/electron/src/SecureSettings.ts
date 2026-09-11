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
  /** Fallbacks written while OS encryption was unavailable; see `Cipher`. */
  plainSyncUrl?: string
  plainSecrets?: Record<string, string>
}

/**
 * The OS-backed cipher behind the settings. `safeStorage` reports itself
 * unavailable when it cannot reach its key: on macOS the key lives in a
 * Keychain item whose access list names the code signature that created it,
 * so every ad-hoc re-signed (unsigned) build is refused, and until a build is
 * signed with a stable identity no macOS development package can decrypt what
 * an earlier one wrote. Rather than failing every save, secrets are then kept
 * unencrypted in the settings file, which is private to the user account, and
 * are re-encrypted the next time they are saved while encryption works.
 */
export interface Cipher {
  isAvailable(): boolean
  encrypt(value: string): string
  decrypt(encrypted: string): string
}

const safeStorageCipher: Cipher = {
  isAvailable: () => safeStorage.isEncryptionAvailable(),
  encrypt: (value) => safeStorage.encryptString(value).toString("base64"),
  decrypt: (encrypted) =>
    safeStorage.decryptString(Buffer.from(encrypted, "base64"))
}

export class SecureSettings {
  private warnedPlainText = false

  constructor(
    private readonly filePath = path.join(
      app.getPath("userData"),
      "once-v2-settings.json"
    ),
    private readonly cipher: Cipher = safeStorageCipher,
    private readonly warn: (message: string) => void = console.warn
  ) {}

  async getSyncUrl(): Promise<string> {
    const settings = await this.read()
    return this.reveal(settings.encryptedSyncUrl, settings.plainSyncUrl)
  }

  async setSyncUrl(syncUrl: string): Promise<void> {
    const settings = await this.read()
    if (this.cipher.isAvailable()) {
      settings.encryptedSyncUrl = this.cipher.encrypt(syncUrl)
      delete settings.plainSyncUrl
    } else {
      this.warnPlainText()
      settings.plainSyncUrl = syncUrl
      delete settings.encryptedSyncUrl
    }
    await this.write(settings)
  }

  async getSecret(key: string): Promise<string> {
    const settings = await this.read()
    return this.reveal(
      settings.encryptedSecrets?.[key],
      settings.plainSecrets?.[key]
    )
  }

  async setSecret(key: string, value: string): Promise<void> {
    const settings = await this.read()
    const encrypted = without(settings.encryptedSecrets, key)
    const plain = without(settings.plainSecrets, key)
    if (value && this.cipher.isAvailable()) {
      encrypted[key] = this.cipher.encrypt(value)
    } else if (value) {
      this.warnPlainText()
      plain[key] = value
    }
    settings.encryptedSecrets = encrypted
    settings.plainSecrets = plain
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

  /** An encrypted value wins; a plain one stands in until it is re-saved. */
  private reveal(encrypted?: string, plain?: string): string {
    if (encrypted) {
      if (this.cipher.isAvailable()) return this.decrypt(encrypted, plain)
      if (plain === undefined) {
        throw new Error(
          "Secure credential storage is unavailable, so a value saved by an " +
          "earlier build cannot be read. Save it again to replace it."
        )
      }
    }
    return plain ?? ""
  }

  /**
   * macOS can report the Keychain as available and still refuse the item
   * (the user denied the prompt); a plain copy stands in, else a readable error.
   */
  private decrypt(encrypted: string, plain?: string): string {
    try {
      return this.cipher.decrypt(encrypted)
    } catch (error) {
      if (plain !== undefined) return plain
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(
        "Secure credential storage refused to decrypt a saved value. " +
        `Save it again to replace it. (${detail})`
      )
    }
  }

  private warnPlainText(): void {
    if (this.warnedPlainText) return
    this.warnedPlainText = true
    this.warn(
      "Secure credential storage is unavailable; saving credentials " +
      `unencrypted in ${this.filePath}. On macOS this happens when an ` +
      "unsigned (ad-hoc) build is refused its Keychain item, " +
      `"${app.name} Safe Storage".`
    )
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
    await fs.writeFile(temporaryPath, JSON.stringify(settings, null, 2), {
      encoding: "utf8",
      mode: 0o600
    })
    await fs.rename(temporaryPath, this.filePath)
  }
}

function without(
  record: Record<string, string> | undefined,
  key: string
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record ?? {}).filter(([name]) => name !== key)
  )
}
