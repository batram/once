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

export interface ExtensionProtocolOptions {
  /**
   * Serve only `web_accessible_resources`. This is the browser session's
   * view of an extension: pages may load what the manifest exposes, never
   * the extension's own UI or scripts.
   */
  webAccessibleOnly?: boolean
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

export async function serveExtensionRequest(
  url: string,
  lookup: ExtensionLookup,
  options: ExtensionProtocolOptions = {}
): Promise<Response> {
  const parts = parseExtensionUrl(url)
  if (!parts) return notFound("Not an extension URL")
  const extension = lookup(parts.host)
  if (!extension) return notFound("Unknown extension")

  if (options.webAccessibleOnly && !isWebAccessible(extension, parts.path)) {
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
export function configureExtensionProtocol(
  targetSession: Session,
  lookup: ExtensionLookup,
  options: ExtensionProtocolOptions = {}
): void {
  targetSession.protocol.handle(EXTENSION_SCHEME, (request) =>
    serveExtensionRequest(request.url, lookup, options)
  )
}
