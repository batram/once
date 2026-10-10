import { readFileSync } from "node:fs"
import { CustomScheme, net, Session } from "electron"
import { devAddonFile } from "./devAddons"

/**
 * Serves the add-on sandbox page and its runtime, which Forge emits as the
 * `addon_sandbox` renderer entry beside the shell, and the PDF sandbox page
 * (`pdf_sandbox`, under the `pdf` host) the same way. The renderer loads each
 * in a sandboxed frame; that frame's opaque origin may not load `file:`
 * subresources, so the pages come through a scheme of their own, like the
 * reader's. Only the three files an entry consists of are served, plus, in
 * unpackaged builds, the files of `ONCE_ADDONS` development directories under
 * `once-addon://dev/<index>/<file>`.
 */
const SERVED = new Set(["index.html", "index.js", "index.js.map"])
const SANDBOX_ENTRIES: Record<string, string> = { pdf: "pdf_sandbox" }

/** For the app's one `registerSchemesAsPrivileged` call. */
export function addonSandboxScheme(): CustomScheme {
  return {
    scheme: "once-addon",
    privileges: { standard: true, secure: true, supportFetchAPI: true }
  }
}

function notFound(text: string): Response {
  return new Response(text, { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } })
}

/**
 * `shellEntryUrl` is the shell's own entry URL (a `file:` path when packaged,
 * the dev server when not); the sandbox entry sits beside it either way.
 */
export function configureAddonSandboxProtocol(
  targetSession: Session,
  shellEntryUrl: string,
  devDirectories: readonly string[] = []
): void {
  targetSession.protocol.handle("once-addon", (request) => {
    const url = new URL(request.url)
    if (url.host === "dev") {
      const file = devAddonFile(devDirectories, request.url)
      if (!file) return notFound("Not a development add-on file")
      const type = file.endsWith(".json") ? "application/json" : "text/javascript"
      return new Response(readFileSync(file), { headers: { "content-type": `${type}; charset=utf-8` } })
    }
    const name = url.pathname.split("/").pop() ?? ""
    if (!SERVED.has(name)) return notFound("Not part of a sandbox page")
    const entry = SANDBOX_ENTRIES[url.host] ?? "addon_sandbox"
    return net.fetch(new URL(`../${entry}/${name}`, shellEntryUrl).toString())
  })
}

/**
 * The conversation page, for the browser session's tabs: the Forge
 * `addon_conversation` entry plus the shell's stylesheet folder, which the
 * page links as `css/…`. Nothing else under the scheme is reachable from a
 * tab, so a page there cannot load the sandbox or a development add-on.
 */
export function configureAddonConversationProtocol(targetSession: Session, shellEntryUrl: string): void {
  targetSession.protocol.handle("once-addon", (request) => {
    const url = new URL(request.url)
    if (url.host !== "conversation") return notFound("Not an add-on conversation file")
    const parts = url.pathname.split("/").filter(Boolean)
    if (parts[0] === "css" && parts.length > 1 && parts.every(part => /^[\w.-]+$/.test(part) && part !== "..")) {
      return net.fetch(new URL(`../main_window/${parts.join("/")}`, shellEntryUrl).toString())
    }
    // Forge writes the entry's script tag as `../addon_conversation/index.js`,
    // so as with the sandbox only the file name decides what is served.
    const name = parts.pop() ?? ""
    if (!SERVED.has(name)) return notFound("Not part of the add-on conversation page")
    return net.fetch(new URL(`../addon_conversation/${name}`, shellEntryUrl).toString())
  })
}
