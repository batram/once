import { OnceClient } from "@once/app"

let client: OnceClient | null = null

export function setOnceClient(nextClient: OnceClient): void {
  client = nextClient
}

export function getOnceClient(): OnceClient {
  if (!client) {
    throw new Error("OnceClient has not been configured")
  }
  return client
}
