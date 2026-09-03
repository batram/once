// The extensions Once ships: an explicit list, because every entry widens
// the browser.* surface the runtime has to honour. The bundles themselves
// come from scripts/fetch-extensions.js into vendor/extensions during
// development and travel as packaged resources in a release.

import { existsSync } from "node:fs"
import path from "node:path"

export interface BundledExtension {
  /** The Firefox extension id the manifest must carry. */
  id: string
  /** Directory name under the vendor root. */
  directory: string
}

export const BUNDLED_EXTENSIONS: readonly BundledExtension[] = [
  { id: "uBlock0@raymondhill.net", directory: "ublock-origin" },
  { id: "{aecec67f-0d10-4fa7-b7c7-609a2db280cf}", directory: "violentmonkey" }
]

export interface BundledExtensionSource {
  id: string
  directory: string
  /** Missing on a development checkout that has not run the fetch yet. */
  present: boolean
}

/**
 * Where the vendored bundles are for this build: resources when packaged,
 * otherwise the checkout's `vendor/extensions`. The app path of a checkout
 * is `apps/electron` under Forge but the webpack output directory when the
 * e2e harness runs the built main script, so walk up until the vendor
 * directory appears; the conventional spot is the answer when it does not.
 */
export function bundledExtensionRoot(
  options: { isPackaged: boolean; resourcesPath: string; appPath: string },
  exists: (directory: string) => boolean = existsSync
): string {
  if (options.isPackaged) return path.join(options.resourcesPath, "extensions")
  let directory = path.resolve(options.appPath)
  for (;;) {
    const candidate = path.join(directory, "vendor", "extensions")
    if (exists(candidate)) return candidate
    const parent = path.dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return path.resolve(options.appPath, "..", "..", "vendor", "extensions")
}

export function resolveBundledExtensions(
  root: string,
  exists: (directory: string) => boolean = existsSync
): BundledExtensionSource[] {
  return BUNDLED_EXTENSIONS.map((entry) => {
    const directory = path.join(root, entry.directory)
    return { id: entry.id, directory, present: exists(path.join(directory, "manifest.json")) }
  })
}
