import { promises as fs } from "node:fs"
import { Session } from "electron"
import { EXTENSION_SCHEME } from "./protocol"
import { parseExtensionUrl } from "./ExtensionScheme"
import {
  GENERATED_BACKGROUND_PAGE,
  LoadedExtension,
  generatedBackgroundHtml,
  mimeTypeFor,
  resolveExtensionFile
} from "./LoadedExtension"

export type ExtensionLookup = (host: string) => LoadedExtension | undefined

/**
 * A web-accessible page that a tab is showing is the extension's own origin
 * and may load the rest of the extension, as in Firefox: uBlock's element
 * picker frame pulls in its scripts and styles that way. The protocol
 * handler learns nothing about who asks, and Chromium sends no referrer
 * between documents of a custom scheme, but the session's webRequest hook
 * sees the requesting frame first: it grants each such URL, and the handler
 * takes the grant when it serves.
 */
export class OwnPageRequests {
  private readonly granted = new Map<string, number>()

  grant(url: string): void {
    this.granted.set(url, (this.granted.get(url) ?? 0) + 1)
  }

  take(url: string): boolean {
    const count = this.granted.get(url) ?? 0
    if (count === 0) return false
    if (count === 1) this.granted.delete(url)
    else this.granted.set(url, count - 1)
    return true
  }
}

export interface ExtensionProtocolOptions {
  /**
   * Serve only `web_accessible_resources`. This is the browser session's
   * view of an extension: pages may load what the manifest exposes, never
   * the extension's own UI or scripts.
   */
  webAccessibleOnly?: boolean
  /** Requests the extension's own page frames make, served regardless. */
  ownPages?: OwnPageRequests
}

function notFound(reason: string): Response {
  return new Response(reason, {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" }
  })
}

function globToRegExp(glob: string): RegExp {
  const normalized = glob.startsWith("/") ? glob : `/${glob}`
  const escaped = normalized.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")
  return new RegExp(`^${escaped}$`)
}

export function isWebAccessible(extension: LoadedExtension, path: string): boolean {
  return extension.manifest.webAccessibleResources.some((glob) => globToRegExp(glob).test(path))
}

/** Whether a document at `documentUrl` is one of the extension's own pages a tab may show. */
export function isOwnPage(extension: LoadedExtension, documentUrl: string | null): boolean {
  const page = documentUrl === null ? null : parseExtensionUrl(documentUrl)
  return page !== null && page.host === extension.host && isWebAccessible(extension, page.path)
}

export async function serveExtensionRequest(
  url: string,
  lookup: ExtensionLookup,
  options: ExtensionProtocolOptions = {}
): Promise<Response> {
  const parts = parseExtensionUrl(url)
  if (!parts) return notFound("Not an extension URL")
  const extension = lookup(parts.host)
  if (!extension) return notFound("Unknown extension")

  if (options.webAccessibleOnly && !isWebAccessible(extension, parts.path) &&
    !options.ownPages?.take(url)) {
    return notFound("Not a web accessible resource")
  }

  if (parts.path === GENERATED_BACKGROUND_PAGE) {
    const background = extension.manifest.background
    if (!background || background.kind !== "scripts") {
      return notFound("This extension has no generated background page")
    }
    return new Response(generatedBackgroundHtml(background.scripts), {
      headers: { "content-type": "text/html; charset=utf-8" }
    })
  }

  const file = resolveExtensionFile(extension, parts.path)
  if (!file) return notFound("Path is outside the extension")
  try {
    const body = await fs.readFile(file)
    return new Response(body, {
      headers: {
        "content-type": mimeTypeFor(file),
        "cache-control": "no-cache"
      }
    })
  } catch {
    return notFound("No such extension file")
  }
}

/** Serves `moz-extension://<host>/<path>` from the extension's directory. */
const configuredSessions = new WeakSet<Session>()

export function configureExtensionProtocol(
  targetSession: Session,
  lookup: ExtensionLookup,
  options: ExtensionProtocolOptions = {}
): void {
  if (configuredSessions.has(targetSession)) targetSession.protocol.unhandle(EXTENSION_SCHEME)
  targetSession.protocol.handle(EXTENSION_SCHEME, (request) =>
    serveExtensionRequest(request.url, lookup, options)
  )
  configuredSessions.add(targetSession)
}
