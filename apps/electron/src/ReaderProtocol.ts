import { protocol, Session } from "electron"

const documents = new Map<string, string>()

export function registerReaderScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: "once-reader",
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true
      }
    }
  ])
}

export function configureReaderProtocol(targetSession: Session): void {
  targetSession.protocol.handle("once-reader", (request) => {
    const sourceUrl = sourceUrlFromReaderUrl(request.url)
    const html = sourceUrl ? documents.get(sourceUrl) : undefined
    if (!html) {
      return new Response("Reader document is no longer available", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8" }
      })
    }
    return new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8" }
    })
  })
}

export function storeReaderDocument(sourceUrl: string, html: string): string {
  const parsed = new URL(sourceUrl)
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Reader source must use HTTP or HTTPS")
  }
  const normalized = parsed.toString()
  documents.set(normalized, html)
  return `once-reader://${normalized}`
}

export function hasReaderDocument(sourceUrl: string): boolean {
  return documents.has(sourceUrl)
}

export function sourceUrlFromReaderUrl(readerUrl: string): string | null {
  if (!readerUrl.startsWith("once-reader://")) return null
  try {
    const parsed = new URL(readerUrl)
    if (parsed.hostname !== "http" && parsed.hostname !== "https") return null
    return new URL(`${parsed.hostname}:${parsed.pathname}${parsed.search}${parsed.hash}`).toString()
  } catch {
    return null
  }
}
