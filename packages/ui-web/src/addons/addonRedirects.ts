import { AddonRedirectHandler, OnceClient } from "@once/app"
import { AddonManifest } from "@once/core"
import type { AddonSandbox } from "./AddonSandbox"

/**
 * Hands an add-on's manifest redirects to the app while the add-on is
 * registered. A dynamic rule's replacement comes from the script, so the
 * handler starts the sandbox only when the app asks: at startup when the
 * last pick is too old, and when a page the rule produced failed to load.
 */
export function registerAddonRedirects(client: OnceClient, manifest: AddonManifest, sandbox: AddonSandbox | null): () => void {
  const rules = manifest.redirects ?? []
  if (rules.length === 0) return () => undefined
  const replacement = (value: unknown): string | null => typeof value === "string" ? value : null
  const handler: AddonRedirectHandler | null = sandbox ? {
    target: async (redirect) => {
      const session = await sandbox.ensure()
      return replacement(await session.resolve((requestId) => ({ type: "redirect.target", requestId, redirect })))
    },
    failed: async (redirect, url, reason) => {
      const session = await sandbox.ensure()
      return replacement(await session.resolve((requestId) => ({ type: "redirect.failed", requestId, redirect, url, reason })))
    }
  } : null
  let release: (() => void) | null = null
  let disposed = false
  void client.registerAddonRedirects(manifest.id, manifest.name, rules, handler)
    .then((withdraw) => { if (disposed) withdraw(); else release = withdraw })
    .catch((error) => console.error(`Add-on ${manifest.name} could not register its redirects`, error))
  return () => {
    disposed = true
    release?.()
  }
}
