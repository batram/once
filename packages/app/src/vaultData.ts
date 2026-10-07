import { AddonsDocument, SANDBOX_LIMITS, readAddonsDocument } from "@once/core"

export interface VaultData {
  document: AddonsDocument
  secrets: Record<string, string>
  scripts: Record<string, string>
  generation: number
  commit: string
  author: string
  updatedAt: string
}

export function readVaultData(value: unknown): VaultData {
  const data = value as Partial<VaultData> | null
  if (!data || !Number.isSafeInteger(data.generation) || Number(data.generation) < 1 || typeof data.commit !== "string" ||
      typeof data.author !== "string" || typeof data.updatedAt !== "string" || !data.document ||
      !data.secrets || !data.scripts || Array.isArray(data.secrets) || Array.isArray(data.scripts)) throw new Error("Invalid vault contents")
  if (data.author.length > 80 || data.commit.length > 80) throw new Error("Invalid vault metadata")
  const normalized = readAddonsDocument(data.document)
  if (JSON.stringify(normalized) !== JSON.stringify(data.document)) throw new Error("Vault contains an invalid add-on; update Once before opening it")
  for (const [name, text] of Object.entries(data.secrets)) {
    if (!/^addon:[a-z0-9-]{3,40}:[a-zA-Z_][a-zA-Z0-9_]{0,39}$/.test(name) || typeof text !== "string" || text.length > 16000) throw new Error("Invalid vault connection")
  }
  for (const [hash, code] of Object.entries(data.scripts)) {
    if (!hash.startsWith("sha256-") || typeof code !== "string" || new TextEncoder().encode(code).length > SANDBOX_LIMITS.code) throw new Error("Invalid vault package")
  }
  return data as VaultData
}

/**
 * Whether two snapshots hold the same add-ons, settings, tokens and packages.
 * Generation, commit, author and time say who wrote it, not what it holds, so
 * two devices making the same change at once compare equal.
 */
export function sameVaultContents(left: VaultData, right: VaultData): boolean {
  const contents = ({ document, secrets, scripts }: VaultData) => canonical({ document, secrets, scripts })
  return contents(left) === contents(right)
}

/** JSON with object keys sorted, so key order from different writers does not matter. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`
  }
  return JSON.stringify(value)
}

export async function verifyVaultScript(hash: string, code: string): Promise<void> {
  const bytes = new TextEncoder().encode(code)
  if (bytes.length > SANDBOX_LIMITS.code) throw new Error("The add-on script is too large")
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  if (`sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}` !== hash) throw new Error("Script integrity does not match the approved package")
}
