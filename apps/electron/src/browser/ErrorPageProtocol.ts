import { randomUUID } from "node:crypto"
import { protocol, Session } from "electron"
import errorPageTemplate from "./error-page.html"
import errorPageStyles from "./error-page.css"

interface ErrorDocument {
  url: string
  error: string
  background: string
  retryable: boolean
}

const documents = new Map<string, ErrorDocument>()

export function registerErrorPageScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: "once-error",
      privileges: { standard: true, secure: true }
    }
  ])
}

export function configureErrorPageProtocol(targetSession: Session): void {
  targetSession.protocol.handle("once-error", (request) => {
    const requested = new URL(request.url)
    if (requested.hostname === "style") {
      const document = documents.get(requested.pathname.slice(1))
      if (!document) return notFound()
      const background = errorPageTheme(document.background).background
      return new Response(`${errorPageStyles}\n:root { --page-bg: ${background}; }`, {
        headers: { "content-type": "text/css; charset=utf-8" }
      })
    }
    if (requested.hostname !== "page") return notFound()

    const document = documents.get(requested.pathname.slice(1))
    if (!document) return notFound()
    return new Response(renderErrorPage(document, requested.pathname.slice(1)), {
      headers: { "content-type": "text/html; charset=utf-8" }
    })
  })
}

export function storeErrorPage(
  url: string,
  error: string,
  background: string,
  retryable: boolean
): string {
  const token = randomUUID()
  documents.set(token, { url, error, background, retryable })
  return `once-error://page/${token}`
}

export function releaseErrorPages(urls: Iterable<string>): void {
  for (const url of urls) {
    try {
      const parsed = new URL(url)
      if (parsed.protocol === "once-error:" && parsed.hostname === "page") {
        documents.delete(parsed.pathname.slice(1))
      }
    } catch {
      // Ignore malformed history entries during cleanup.
    }
  }
}

export function errorPageTheme(background: string): {
  name: "light" | "dark"
  background: string
} {
  const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})/i.exec(background)
  if (!match) return { name: "light", background: "#FFFFFF" }
  const [red, green, blue] = match.slice(1).map((value) => Number.parseInt(value, 16))
  const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255
  return { name: luminance < 0.5 ? "dark" : "light", background }
}

function renderErrorPage(document: ErrorDocument, token: string): string {
  const theme = errorPageTheme(document.background)
  const safeUrl = escapeHtml(document.url)
  return errorPageTemplate
    .replace("{{THEME}}", theme.name)
    .replace("{{STYLESHEET}}", `once-error://style/${token}`)
    .replace("{{ERROR}}", escapeHtml(document.error))
    .replace("{{URL}}", safeUrl)
    .replace(
      "{{RETRY}}",
      document.retryable ? `<a class="retry" href="${safeUrl}">Try again</a>` : ""
    )
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function notFound(): Response {
  return new Response("Error document is no longer available", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" }
  })
}
