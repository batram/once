import { createHash } from "node:crypto"
import { CustomScheme } from "electron"
import { EXTENSION_SCHEME } from "./protocol"

/**
 * Extension ids such as `uBlock0@raymondhill.net` are not valid hostnames, so
 * each extension gets a stable, opaque host derived from its id, the way
 * Firefox gives every install a `moz-extension://<uuid>` origin.
 */
export function hostForExtensionId(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 32)
}

export function extensionUrl(host: string, path = "/"): string {
  const normalized = path.startsWith("/") ? path : `/${path}`
  return `${EXTENSION_SCHEME}://${host}${normalized}`
}

export interface ExtensionUrlParts {
  host: string
  /** Decoded path with a leading slash; query and fragment removed. */
  path: string
}

export function parseExtensionUrl(url: string): ExtensionUrlParts | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== `${EXTENSION_SCHEME}:` || !parsed.hostname) return null
  let path: string
  try {
    path = decodeURIComponent(parsed.pathname)
  } catch {
    return null
  }
  return { host: parsed.hostname, path }
}

/**
 * The scheme's privileges, for the app's one `registerSchemesAsPrivileged`
 * call before `app.whenReady()`: Electron keeps only the last such call, so
 * every scheme must be in it.
 */
export function extensionScheme(): CustomScheme {
  return {
    scheme: EXTENSION_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      // A page's CSP does not apply to the extension's own URLs, as in
      // Firefox: uBlock's element picker is an extension frame appended to
      // pages whose `frame-src` would otherwise refuse it.
      bypassCSP: true,
      allowServiceWorkers: false
    }
  }
}
