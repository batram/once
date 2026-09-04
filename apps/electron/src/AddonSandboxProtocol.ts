import { readFileSync } from "node:fs"
import { CustomScheme, net, Session } from "electron"
import { devAddonFile } from "./devAddons"

/**
 * Serves the add-on sandbox page and its runtime, which Forge emits as the
 * `addon_sandbox` renderer entry beside the shell. The renderer loads it in a
 * sandboxed frame; that frame's opaque origin may not load `file:`
 * subresources, so the page comes through a scheme of its own, like the
 * reader's. Only the three files the entry consists of are served, plus, in
 * unpackaged builds, the files of `ONCE_ADDONS` development directories under
 * `once-addon://dev/<index>/<file>`.
 */
const SERVED = new Set(["index.html", "index.js", "index.js.map"])

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
    if (!SERVED.has(name)) return notFound("Not part of the add-on sandbox")
    return net.fetch(new URL(`../addon_sandbox/${name}`, shellEntryUrl).toString())
  })
}
