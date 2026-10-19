import { promises as fs } from "node:fs"
import path from "node:path"
import { JsonStore } from "../hostServices"

/**
 * One JSON file per name under a directory, written through a `.tmp` file
 * and a rename so a reader never sees a partial document.
 */
export class NodeJsonStore implements JsonStore {
  constructor(private readonly root: string) {}

  private file(name: string): string {
    return path.join(this.root, name)
  }

  async read(name: string): Promise<unknown> {
    let text: string
    try {
      text = await fs.readFile(this.file(name), "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    }
    return JSON.parse(text)
  }

  async write(name: string, value: unknown): Promise<void> {
    const file = this.file(name)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(`${file}.tmp`, JSON.stringify(value), "utf8")
    await fs.rename(`${file}.tmp`, file)
  }
}
