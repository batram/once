export function normalizeSyncUrl(value: string): string {
  const normalized = value.trim()
  if (!normalized) return ""

  let parsed: URL
  try {
    parsed = new URL(normalized)
  } catch {
    throw invalidSyncUrlError()
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    !parsed.hostname
  ) {
    throw invalidSyncUrlError()
  }
  return normalized
}

function invalidSyncUrlError(): Error {
  return new Error("CouchDB URL must start with http:// or https://")
}
