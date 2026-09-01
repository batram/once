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

function notFound(reason: string): Response {
  return new Response(reason, {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" }
  })
}

export async function serveExtensionRequest(
  url: string,
  lookup: ExtensionLookup
): Promise<Response> {
  const parts = parseExtensionUrl(url)
  if (!parts) return notFound("Not an extension URL")
  const extension = lookup(parts.host)
  if (!extension) return notFound("Unknown extension")

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

/** Serves `once-ext://<host>/<path>` from the extension's directory. */
export function configureExtensionProtocol(
  targetSession: Session,
  lookup: ExtensionLookup
): void {
  targetSession.protocol.handle(EXTENSION_SCHEME, (request) =>
    serveExtensionRequest(request.url, lookup)
  )
}
