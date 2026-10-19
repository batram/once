// `JsonStore` over Java: one JSON document per name, kept as a file under
// `<files>/lite-extensions/<directory>/<name>` and replaced atomically
// (write to a sibling, rename). The broker only ever sees the text.

import { JsonStore } from "@once/webext-runtime"
import { JavaChannel } from "./javaChannel"
import { StoreReadParams, StoreWriteParams } from "./protocol"

export class LiteJsonStore implements JsonStore {
  constructor(private readonly channel: JavaChannel, private readonly directory: string) {}

  async read(name: string): Promise<unknown> {
    const result = await this.channel.request<{ json: string | null }>("store.read", {
      directory: this.directory, name
    } satisfies StoreReadParams)
    if (result.json === null) return undefined
    return JSON.parse(result.json)
  }

  async write(name: string, value: unknown): Promise<void> {
    await this.channel.request("store.write", {
      directory: this.directory, name, json: JSON.stringify(value)
    } satisfies StoreWriteParams)
  }
}
