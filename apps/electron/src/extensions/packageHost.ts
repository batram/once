// Installing extensions on Electron: Mozilla's servers through `net.fetch`,
// archives through adm-zip, packages on disk under the storage root.

import { promises as fs } from "node:fs"
import { app, net } from "electron"
import AdmZip from "adm-zip"
import { ExtensionPackageHost } from "@once/webext-runtime"
import { NodePackageStore, sha256Node } from "@once/webext-runtime/node"

export function electronPackageHost(storageRoot: string): ExtensionPackageHost {
  return {
    fetch: (url, init) => net.fetch(url, init),
    sha256: sha256Node,
    unzip: (archive) => new AdmZip(Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength)).getEntries()
      .map((entry) => ({
        name: entry.entryName,
        isDirectory: entry.isDirectory,
        size: entry.header.size,
        data: () => entry.getData()
      })),
    readArchive: (file) => fs.readFile(file),
    locale: () => app.getLocale(),
    packages: new NodePackageStore(storageRoot)
  }
}
