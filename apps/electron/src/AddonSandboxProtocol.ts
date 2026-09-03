import { net, protocol, Session } from "electron"

/**
 * Serves the add-on sandbox page and its runtime, which Forge emits as the
 * `addon_sandbox` renderer entry beside the shell. The renderer loads it in a
 * sandboxed frame; that frame's opaque origin may not load `file:`
 * subresources, so the page comes through a scheme of its own, like the
 * reader's. Only the three files the entry consists of are served.
 */
const SERVED = new Set(["index.html", "index.js", "index.js.map"])

export function registerAddonSandboxScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: "once-addon",
      privileges: { standard: true, secure: true, supportFetchAPI: true }
    }
  ])
}

/**
 * `shellEntryUrl` is the shell's own entry URL (a `file:` path when packaged,
 * the dev server when not); the sandbox entry sits beside it either way.
 */
export function configureAddonSandboxProtocol(targetSession: Session, shellEntryUrl: string): void {
  targetSession.protocol.handle("once-addon", (request) => {
    const name = new URL(request.url).pathname.split("/").pop() ?? ""
    if (!SERVED.has(name)) {
      return new Response("Not part of the add-on sandbox", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8" }
      })
    }
    return net.fetch(new URL(`../addon_sandbox/${name}`, shellEntryUrl).toString())
  })
}
