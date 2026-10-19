import { readFileSync } from "node:fs"
import { promises as fs } from "node:fs"
import path from "node:path"
import { ExtensionFileReader, ExtensionPackageStore } from "../hostServices"
import { LoadedExtension, extensionFilePath, loadExtension } from "../LoadedExtension"

/** Reads an unpacked extension's files from a directory on disk. */
export function nodeFileReader(directory: string): ExtensionFileReader {
  return {
    read(relativePath) {
      try {
        return readFileSync(path.join(directory, relativePath)) as unknown as Uint8Array
      } catch {
        return null
      }
    }
  }
}

export function loadUnpackedExtension(directory: string, uiLanguage: string): Promise<LoadedExtension> {
  const resolved = path.resolve(directory)
  return loadExtension(resolved, nodeFileReader(resolved), uiLanguage)
}

/**
 * The absolute file for an extension-relative path, or null when the path
 * would leave the extension directory. Existence is the caller's question.
 */
export function resolveExtensionFile(extension: Pick<LoadedExtension, "directory">, relativePath: string): string | null {
  const relative = extensionFilePath(relativePath)
  return relative === null ? null : path.join(extension.directory, relative)
}

/** Packages unpacked under `<root>/packages/<token>/`. */
export class NodePackageStore implements ExtensionPackageStore {
  private readonly packagesRoot: string

  constructor(root: string) {
    this.packagesRoot = path.join(root, "packages")
  }

  directory(token: string): string {
    return path.join(this.packagesRoot, token)
  }

  async mkdir(directory: string, relativePath: string): Promise<void> {
    await fs.mkdir(path.join(directory, relativePath), { recursive: true })
  }

  async writeFile(directory: string, relativePath: string, data: Uint8Array): Promise<void> {
    const file = path.join(directory, relativePath)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, data, { flag: "wx" })
  }

  async remove(directory: string): Promise<void> {
    await fs.rm(directory, { recursive: true, force: true })
  }

  async list(): Promise<{ name: string; directory: string }[]> {
    try {
      const names = await fs.readdir(this.packagesRoot)
      return names.map((name) => ({ name, directory: path.join(this.packagesRoot, name) }))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
      throw error
    }
  }

  canonical(directory: string): string {
    return path.resolve(directory)
  }

  reader(directory: string): ExtensionFileReader {
    return nodeFileReader(directory)
  }
}


