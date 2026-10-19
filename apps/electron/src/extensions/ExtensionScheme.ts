import { CustomScheme } from "electron"
import { EXTENSION_SCHEME } from "@once/webext-runtime"

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
