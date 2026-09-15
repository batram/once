import { CustomScheme, Session } from "electron"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { sourceUrlFromReaderUrl } from "./browser/reader-url"

const documents = new Map<string, string>()

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
    if (url.hostname === "runtime" && url.pathname === "/reader.js") {
      try {
        return new Response(await runtimeSource, {
          headers: {
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
            "cache-control": "public, max-age=31536000, immutable",
            "content-type": "application/wasm"
          }
        })
      } catch (error) {
        console.error("Unable to load the bundled Wafli runtime", error)
        return new Response("Wafli runtime unavailable", { status: 503 })
      }
    }
    const sourceUrl = sourceUrlFromReaderUrl(request.url)
    const html = sourceUrl ? documents.get(sourceUrl) : undefined
    if (!html) {
      return new Response("Reader document is no longer available", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8" }
      })
    }
    const document = html.replace(
      /<script data-once-reader-runtime><\/script>/,
      '<script data-once-reader-runtime src="once-reader://runtime/reader.js"></script>'
    )
    return new Response(document, {
      headers: { "content-type": "text/html; charset=utf-8" }
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
