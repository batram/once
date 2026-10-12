import { CustomScheme, net, Session } from "electron"
import { randomUUID } from "node:crypto"

/**
 * Serves image text selection's words frame (the Forge
 * `image_text_overlay` entry), which the page's host (imageTextAnchor.ts)
 * hangs on the image, and the picture recognition read, for the frame's
 * reading flourish. Each selection has a host of its own,
 * `once-image-text://<id>/`, served only while it is open: no page can
 * probe for the scheme, and a frame of one selection cannot read another's
 * picture. The scheme is secure and bypasses the page's Content Security
 * Policy, so a page's `frame-src` cannot keep the selection out; and it is
 * cross-origin to every page, so the page cannot reach into it.
 *
 * The selection's token, which the host and the frame authenticate each
 * other with, is in no URL: the frame reads it from its own page, which only
 * it can read. The URL's id is random and says nothing about it. (Chromium
 * keeps this scheme's loads out of the page's resource timing as it is, while
 * it lists an http(s) iframe there with its URL even from a closed shadow root.)
 */
export const IMAGE_TEXT_SCHEME = "once-image-text"
const SERVED = new Set(["index.html", "index.js", "index.js.map"])
const TOKEN_META = "once-image-text-token"

/** For the app's one `registerSchemesAsPrivileged` call. */
export function imageTextScheme(): CustomScheme {
  return { scheme: IMAGE_TEXT_SCHEME, privileges: { standard: true, secure: true, bypassCSP: true, supportFetchAPI: true } }
}

interface Served { token: string; image: Buffer | null }
const selections = new Map<string, Served>()

/** Opens the scheme for a selection; the picture is served once `setImage` has it. */
export function openImageTextFrame(token: string): { url: string; imageUrl: string; setImage(bytes: Buffer): void; close(): void } {
  const id = randomUUID()
  const selection: Served = { token, image: null }
  selections.set(id, selection)
  const origin = `${IMAGE_TEXT_SCHEME}://${id}`
  return {
    url: `${origin}/index.html`,
    imageUrl: `${origin}/image`,
    setImage: (bytes) => { selection.image = bytes },
    close: () => { if (selections.get(id) === selection) selections.delete(id) }
  }
}

function notFound(): Response {
  return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } })
}

// A page that isolates itself (COEP) may embed only frames that opt in.
const EMBEDDABLE = { "cross-origin-resource-policy": "cross-origin", "cross-origin-embedder-policy": "require-corp" }

/**
 * `shellEntryUrl` is the shell's own entry URL (a `file:` path when packaged,
 * the dev server when not); the overlay entry sits beside it either way.
 */
export function configureImageTextProtocol(targetSession: Session, shellEntryUrl: string): void {
  targetSession.protocol.handle(IMAGE_TEXT_SCHEME, async (request) => {
    const url = new URL(request.url)
    const selection = selections.get(url.host)
    if (!selection || request.method !== "GET") return notFound()
    if (url.pathname === "/image") {
      // No type: the image element sniffs it, as for any picture.
      return selection.image ? new Response(new Uint8Array(selection.image), { headers: EMBEDDABLE }) : notFound()
    }
    // Forge writes the entry's script tag as `../image_text_overlay/index.js`,
    // so only the file name decides what is served.
    const name = url.pathname.split("/").pop() ?? ""
    if (!SERVED.has(name)) return notFound()
    const response = await net.fetch(new URL(`../image_text_overlay/${name}`, shellEntryUrl).toString())
    if (!response.ok) return response
    const headers = new Headers(response.headers)
    for (const [key, value] of Object.entries(EMBEDDABLE)) headers.set(key, value)
    if (name !== "index.html") return new Response(response.body, { status: response.status, headers })
    // The token, a UUID, goes into the page itself.
    const page = (await response.text()).replace("</head>", `<meta name="${TOKEN_META}" content="${selection.token}"></head>`)
    headers.delete("content-length")
    return new Response(page, { status: response.status, headers })
  })
}
