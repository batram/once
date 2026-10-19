// Where the shipped extensions are on this machine: resources when packaged,
// otherwise the checkout's `vendor/extensions`. The list itself is shared.

import { existsSync } from "node:fs"
import path from "node:path"
import { BUNDLED_EXTENSIONS, BundledExtensionSource } from "@once/webext-runtime"

export { BUNDLED_EXTENSIONS }

/**
 * The app path of a checkout is `apps/electron` under Forge but the webpack
 * output directory when the e2e harness runs the built main script, so walk
 * up until the vendor directory appears; the conventional spot is the answer
 * when it does not.
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
