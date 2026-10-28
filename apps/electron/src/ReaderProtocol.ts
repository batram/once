import { CustomScheme, Session } from "electron"
import { randomBytes } from "node:crypto"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { readerTokenFromUrl, sourceUrlFromReaderUrl } from "./browser/reader-url"

interface StoredDocument {
  html: string
  /** The host of the document's served URL; stays the same when the document is replaced. */
  token: string
}

const documents = new Map<string, StoredDocument>()

/**
 * What a reader document may do: run the runtime (and its WebAssembly voice)
 * from the scheme's runtime host, show the article's pictures and media, and
 * nothing else. No page may frame it, and it cannot send a form anywhere.
 */
const READER_DOCUMENT_POLICY = [
  "default-src 'none'",
  "script-src once-reader://runtime 'wasm-unsafe-eval'",
  "connect-src once-reader://runtime",
  "style-src 'unsafe-inline'",
  "img-src http: https: data:",
  "media-src http: https:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join("; ")

/** For the app's one `registerSchemesAsPrivileged` call. */
export function readerScheme(): CustomScheme {
  return {
    scheme: "once-reader",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true
    }
  }
}

export function configureReaderProtocol(
  targetSession: Session,
  readerRuntimeEntry: string
): void {
  const runtimeSource = loadReaderRuntime(readerRuntimeEntry)
  const wafliBinary = loadReaderRuntimeAsset(readerRuntimeEntry, "wafli-module.wasm")
  targetSession.protocol.handle("once-reader", async (request) => {
    const url = new URL(request.url)
    // The runtime's files are public and every document is an origin of its own.
    if (url.hostname === "runtime" && url.pathname === "/reader.js") {
      try {
        return new Response(await runtimeSource, {
          headers: {
            "access-control-allow-origin": "*",
            "cache-control": "no-store",
            "content-type": "text/javascript; charset=utf-8"
          }
        })
      } catch (error) {
        console.error("Unable to load the reader runtime", error)
        return new Response("Reader runtime unavailable", { status: 503 })
      }
    }
    if (url.hostname === "runtime" && url.pathname === "/wafli-module.wasm") {
      try {
        return new Response(new Uint8Array(await wafliBinary), {
          headers: {
            "access-control-allow-origin": "*",
            "cache-control": "public, max-age=31536000, immutable",
            "content-type": "application/wasm"
          }
        })
      } catch (error) {
        console.error("Unable to load the bundled Wafli runtime", error)
        return new Response("Wafli runtime unavailable", { status: 503 })
      }
    }
    // Only the served form, with the document's own token, is answered: the
    // readable form names a source any page could guess.
    const token = readerTokenFromUrl(request.url)
    const sourceUrl = token ? sourceUrlFromReaderUrl(request.url) : null
    const stored = sourceUrl ? documents.get(sourceUrl) : undefined
    if (!stored || stored.token !== token) {
      return new Response("Reader document is no longer available", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8" }
      })
    }
    const document = stored.html.replace(
      /<script data-once-reader-runtime><\/script>/,
      '<script data-once-reader-runtime src="once-reader://runtime/reader.js"></script>'
    )
    return new Response(document, {
      headers: {
        "content-security-policy": READER_DOCUMENT_POLICY,
        "content-type": "text/html; charset=utf-8"
      }
    })
  })
}

async function loadReaderRuntimeAsset(entry: string, name: string): Promise<Buffer> {
  const assetUrl = new URL(name, entry)
  if (assetUrl.protocol === "file:") return readFile(fileURLToPath(assetUrl))
  const response = await fetch(assetUrl)
  if (!response.ok) throw new Error(`Reader asset returned ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

async function loadReaderRuntime(entry: string): Promise<string> {
  const runtimeUrl = new URL("index.js", entry)
  if (runtimeUrl.protocol === "file:") {
    return readFile(fileURLToPath(runtimeUrl), "utf8")
  }
  const response = await fetch(runtimeUrl)
  if (!response.ok) throw new Error(`Reader runtime returned ${response.status}`)
  return response.text()
}

function servedUrl(token: string, sourceUrl: string): string {
  return `once-reader://${token}/${sourceUrl}`
}

/** Keeps the document and returns the URL a tab loads it at. */
export function storeReaderDocument(sourceUrl: string, html: string): string {
  const parsed = new URL(sourceUrl)
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Reader source must use HTTP or HTTPS")
  }
  const normalized = parsed.toString()
  // A replaced document keeps its token, so tabs already showing it reload fine.
  const token = documents.get(normalized)?.token ?? randomBytes(16).toString("hex")
  documents.set(normalized, { html, token })
  return servedUrl(token, normalized)
}

export function hasReaderDocument(sourceUrl: string): boolean {
  return documents.has(sourceUrl)
}

/** The served URL of a document held for the source, or null when there is none. */
export function readerUrlFor(sourceUrl: string): string | null {
  const stored = documents.get(sourceUrl)
  return stored ? servedUrl(stored.token, sourceUrl) : null
}
