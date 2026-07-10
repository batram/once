import { ElectronOpenTarget } from "./types"

export type TabOpenDisposition = "current" | "background" | "foreground"

export function normalizeBrowserUrl(value: string): string {
  const trimmed = value.trim()
  if (trimmed === "about:blank") return trimmed

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error("Enter a complete HTTP or HTTPS URL")
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only HTTP and HTTPS URLs are allowed")
  }
  return parsed.toString()
}

export function resolveOpenDisposition(
  target: ElectronOpenTarget
): TabOpenDisposition {
  if (target === "_self") return "current"
  if (target === "middle") return "background"
  return "foreground"
}
