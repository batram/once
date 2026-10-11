import { OnceClient } from "@once/app"

let client: OnceClient | null = null

export function setOnceClient(nextClient: OnceClient): void {
  client = nextClient
}

/** The client when one is configured; for parts that also render without one. */
export function findOnceClient(): OnceClient | null {
  return client
}

export function getOnceClient(): OnceClient {
  if (!client) {
    throw new Error("OnceClient has not been configured")
  }
  return client
}
