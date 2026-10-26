import { randomUUID } from "node:crypto"
import { CustomScheme, Session } from "electron"
import errorPageTemplate from "./error-page.html"
import errorPageStyles from "./error-page.css"

interface ErrorDocument {
  url: string
  error: string
  background: string
  retryable: boolean
}

const documents = new Map<string, ErrorDocument>()

/** For the app's one `registerSchemesAsPrivileged` call. */
export function errorPageScheme(): CustomScheme {
  return {
    scheme: "once-error",
    privileges: { standard: true, secure: true }
  }
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
  const values: Record<string, string> = {
    THEME: theme.name,
    STYLESHEET: `once-error://style/${token}`,
    DESCRIPTION: escapeHtml(describeFailure(document.error)),
    ERROR: escapeHtml(document.error),
    URL: safeUrl,
    RETRY: document.retryable ? `<a class="retry" href="${safeUrl}">Try again</a>` : ""
  }
  // A function, not a replacement string: a URL may well contain "$&" or "$`",
  // which String.replace would expand into parts of the template.
  return errorPageTemplate.replace(/\{\{([A-Z]+)\}\}/g, (placeholder, name: string) => values[name] ?? placeholder)
}

/** Chromium's network errors people run into most, said in words. */
const FAILURE_DESCRIPTIONS: Record<string, string> = {
  ERR_NAME_NOT_RESOLVED: "The site's address could not be found.",
  ERR_INTERNET_DISCONNECTED: "There is no internet connection.",
  ERR_NETWORK_CHANGED: "The network connection changed while the page was loading.",
  ERR_CONNECTION_REFUSED: "The site refused to connect.",
  ERR_CONNECTION_RESET: "The connection was reset.",
  ERR_CONNECTION_CLOSED: "The site closed the connection.",
  ERR_CONNECTION_TIMED_OUT: "The site took too long to respond.",
  ERR_TIMED_OUT: "The site took too long to respond.",
  ERR_ADDRESS_UNREACHABLE: "The site's address cannot be reached.",
  ERR_EMPTY_RESPONSE: "The site sent no data.",
  ERR_TOO_MANY_REDIRECTS: "The site redirected too many times.",
  ERR_BLOCKED_BY_CLIENT: "A browser extension blocked this page.",
  ERR_BLOCKED_BY_RESPONSE: "The site does not allow this page to be shown here.",
  ERR_SSL_PROTOCOL_ERROR: "The site could not provide a secure connection.",
  ERR_UNKNOWN_URL_SCHEME: "This kind of address cannot be opened here."
}

function describeFailure(error: string): string {
  const code = /\bERR_[A-Z0-9_]+/.exec(error)?.[0]
  if (code && FAILURE_DESCRIPTIONS[code]) return FAILURE_DESCRIPTIONS[code]
  if (code?.startsWith("ERR_CERT_")) return "The site's security certificate is not trusted."
  return "The page could not be loaded."
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
