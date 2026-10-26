// Installing extensions on Electron: Mozilla's servers through `net.fetch`,
// archives through adm-zip, packages on disk under the storage root.

import { promises as fs } from "node:fs"
import { app, net } from "electron"
import AdmZip from "adm-zip"
import { ExtensionPackageHost, MAX_ARCHIVE_BYTES } from "@once/webext-runtime"
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
    readArchive,
    locale: () => app.getLocale(),
    packages: new NodePackageStore(storageRoot)
  }
}

/** Bound allocation before reading, including a file that grows after the size check. */
async function readArchive(file: string): Promise<Uint8Array> {
  const handle = await fs.open(file, "r")
  try {
    const { size } = await handle.stat()
    if (size > MAX_ARCHIVE_BYTES) throw new Error("XPI exceeds the 200 MB limit")
    const bytes = Buffer.alloc(size)
    let offset = 0
    while (offset < size) {
      const { bytesRead } = await handle.read(bytes, offset, Math.min(1024 * 1024, size - offset), null)
      if (!bytesRead) break
      offset += bytesRead
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, null)).bytesRead) throw new Error("Extension file changed while reading; choose it again")
    return bytes.subarray(0, offset)
  } finally { await handle.close() }
}
