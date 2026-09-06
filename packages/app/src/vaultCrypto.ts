const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })
export const VAULT_LIMIT = 4 * 1024 * 1024
const ITERATIONS = 600_000

interface Sealed { iv: string; data: string }
export interface VaultEnvelope {
  version: 1
  id: string
  salt: string
  password: Sealed
  recovery: Sealed
  payload: Sealed
}

export function randomHex(bytes = 32): string { return hex(crypto.getRandomValues(new Uint8Array(bytes))) }
function hex(bytes: Uint8Array): string { return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("") }
function unhex(value: string, bytes: number): Uint8Array<ArrayBuffer> {
  if (value.length !== bytes * 2 || !/^[a-f0-9]+$/i.test(value)) throw new Error("Invalid vault key")
  return Uint8Array.from(value.match(/../g) ?? [], byte => parseInt(byte, 16))
}
function base64(bytes: Uint8Array): string {
  let binary = ""
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  return btoa(binary)
}
function unbase64(text: string): Uint8Array<ArrayBuffer> { return Uint8Array.from(atob(text), char => char.charCodeAt(0)) }

async function key(raw: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", unhex(raw, 32), "AES-GCM", false, ["encrypt", "decrypt"])
}
async function passwordKey(passphrase: string, salt: string): Promise<CryptoKey> {
  if (passphrase.length > 1024) throw new Error("Passphrase is too long")
  const material = await crypto.subtle.importKey("raw", encoder.encode(passphrase), "PBKDF2", false, ["deriveKey"])
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: unhex(salt, 16), iterations: ITERATIONS },
    material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"])
}
async function seal(key: CryptoKey, text: string, context: string): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(context) }, key, encoder.encode(text))
  return { iv: hex(iv), data: base64(new Uint8Array(data)) }
}
async function open(key: CryptoKey, sealed: Sealed, context: string): Promise<string> {
  const bytes = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unhex(sealed.iv, 12), additionalData: encoder.encode(context) }, key, unbase64(sealed.data))
  return decoder.decode(bytes)
}
function context(envelope: VaultEnvelope): string {
  return JSON.stringify([1, envelope.id, envelope.salt, envelope.password.iv, envelope.password.data, envelope.recovery.iv, envelope.recovery.data])
}
export function readEnvelope(value: unknown): VaultEnvelope {
  if (JSON.stringify(value)?.length > VAULT_LIMIT * 2) throw new Error("Vault is too large")
  const item = value as Partial<VaultEnvelope> | null
  if (!item || item.version !== 1 || typeof item.id !== "string" || typeof item.salt !== "string") throw new Error("Unsupported or damaged vault")
  unhex(item.id, 16); unhex(item.salt, 16)
  for (const part of [item.password, item.recovery, item.payload]) {
    if (!part || typeof part.iv !== "string" || typeof part.data !== "string") throw new Error("Damaged vault")
    unhex(part.iv, 12)
  }
  return item as VaultEnvelope
}
export function checkPassphrase(passphrase: string): void {
  if (passphrase.length < 12 || passphrase.length > 1024) throw new Error("Use a sync passphrase of at least 12 characters")
}
export async function createEnvelope(passphrase: string): Promise<{ envelope: VaultEnvelope; rawKey: string; recoveryKey: string }> {
  checkPassphrase(passphrase)
  const id = randomHex(16), salt = randomHex(16), rawKey = randomHex(), recoveryKey = randomHex()
  const password = await seal(await passwordKey(passphrase, salt), rawKey, `once-vault:${id}:password`)
  const recovery = await seal(await key(recoveryKey), rawKey, `once-vault:${id}:recovery`)
  return { envelope: { version: 1, id, salt, password, recovery, payload: { iv: "", data: "" } }, rawKey, recoveryKey }
}
export async function unlockEnvelope(envelope: VaultEnvelope, secret: string, recovery: boolean): Promise<string> {
  try {
    return recovery
      ? await open(await key(secret.replace(/[\s-]/g, "")), envelope.recovery, `once-vault:${envelope.id}:recovery`)
      : await open(await passwordKey(secret, envelope.salt), envelope.password, `once-vault:${envelope.id}:password`)
  } catch { throw new Error("Could not unlock. Check the passphrase or recovery key; damaged data also fails verification.") }
}
export async function encryptVault(envelope: VaultEnvelope, rawKey: string, value: unknown): Promise<VaultEnvelope> {
  const text = JSON.stringify(value)
  if (encoder.encode(text).length > VAULT_LIMIT) throw new Error("Synced add-ons exceed the 4 MiB vault limit. Remove unused packages before retrying.")
  return { ...envelope, payload: await seal(await key(rawKey), text, context(envelope)) }
}
export async function decryptVault(envelope: VaultEnvelope, rawKey: string): Promise<unknown> {
  try { return JSON.parse(await open(await key(rawKey), envelope.payload, context(envelope))) }
  catch { throw new Error("Vault verification failed. No synced add-ons or credentials were activated.") }
}
export async function rewrapPassword(envelope: VaultEnvelope, rawKey: string, passphrase: string): Promise<VaultEnvelope> {
  checkPassphrase(passphrase)
  const salt = randomHex(16)
  return { ...envelope, salt, password: await seal(await passwordKey(passphrase, salt), rawKey, `once-vault:${envelope.id}:password`) }
}
