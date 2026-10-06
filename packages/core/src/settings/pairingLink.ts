import { normalizeSyncUrl } from "./syncUrl"

/**
 * A pairing link carries a sync connection to another device, as text or a
 * QR code: `once://pair?v=1&u=<sync URL>[&p=<add-on sync passphrase>]`, both
 * values base64url so a scanner or chat app cannot mangle them. It holds the
 * database password, and the passphrase when the user chose to include it.
 */
export interface PairingPayload {
  syncUrl: string
  passphrase?: string
}

const PREFIX = "once://pair"

export function encodePairingLink(payload: PairingPayload): string {
  const syncUrl = normalizeSyncUrl(payload.syncUrl)
  if (!syncUrl) throw new Error("Connect sync before pairing another device")
  const query = new URLSearchParams({ v: "1", u: toBase64Url(syncUrl) })
  if (payload.passphrase) query.set("p", toBase64Url(payload.passphrase))
  return `${PREFIX}?${query}`
}

/** The connection a pairing link carries; throws for anything else. */
export function decodePairingLink(link: string): PairingPayload {
  const text = link.trim()
  if (!text.startsWith(`${PREFIX}?`)) throw new Error("This is not a Once pairing link")
  const query = new URLSearchParams(text.slice(PREFIX.length + 1))
  if (query.get("v") !== "1") throw new Error("This pairing link needs a newer Once")
  const syncUrl = normalizeSyncUrl(fromBase64Url(query.get("u") ?? ""))
  if (!syncUrl) throw new Error("The pairing link has no sync address")
  const passphrase = query.has("p") ? fromBase64Url(query.get("p") ?? "") : ""
  return passphrase ? { syncUrl, passphrase } : { syncUrl }
}

/** What a confirmation names: the database and the user, never the password. */
export function describeSyncConnection(syncUrl: string): { database: string; user: string } {
  const parsed = new URL(syncUrl)
  return { database: `${parsed.host}${parsed.pathname.replace(/\/+$/, "")}`, user: decodeURIComponent(parsed.username) }
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function fromBase64Url(value: string): string {
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"))
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)))
  } catch {
    throw new Error("The pairing link is damaged")
  }
}
