import { ElectronOpenTarget } from "./types"

export type TabOpenDisposition = "current" | "background" | "foreground"

export function normalizeBrowserUrl(value: string): string {
  const trimmed = value.trim()
  if (trimmed === "about:blank") return trimmed
  const candidate = withDefaultScheme(trimmed)

  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    throw new Error("Enter a complete HTTP or HTTPS URL")
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only HTTP and HTTPS URLs are allowed")
  }
  return parsed.toString()
}

function withDefaultScheme(value: string): string {
  if (value.startsWith("//")) return `https:${value}`

  const explicitScheme = /^([a-z][a-z\d+.-]*):(.*)$/i.exec(value)
  if (!explicitScheme) return `https://${value}`

  // A hostname followed by a numeric port resembles a URL scheme to the URL
  // parser (for example localhost:8443), but is ordinary schemeless input.
  if (/^\d+(?:[/?#]|$)/.test(explicitScheme[2])) return `https://${value}`
  return value
}

export function resolveOpenDisposition(
  target: ElectronOpenTarget
): TabOpenDisposition {
  if (target === "_self") return "current"
  if (target === "middle") return "background"
  return "foreground"
}
