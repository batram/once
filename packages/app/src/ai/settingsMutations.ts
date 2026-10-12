import { AiConnection, AiSelection, SearchConnection, readAiSelection } from "@once/core"
import { AiStore } from "./AiStore"
import { canonical } from "../vaultData"

export interface ConnectionEdit { connection: AiConnection | SearchConnection; token?: string; expected?: AiConnection | SearchConnection | null }
export function editConnection(store: AiStore, { connection, token, expected }: ConnectionEdit): Promise<void> {
  return store.update(data => {
    const current = [...data.settings.connections, ...data.settings.searchConnections].find(item => item.id === connection.id)
    if (expected !== undefined && canonical(current ?? null) !== canonical(expected)) throw new Error("This connection changed in another window. Reload it before saving.")
    if (token !== undefined && (token.length > 8192 || /[\r\n]/.test(token))) throw new Error("Invalid API token")
    const search = connection.provider === "searxng" || connection.provider === "tavily"
    data.settings.connections = data.settings.connections.filter(item => item.id !== connection.id)
    data.settings.searchConnections = data.settings.searchConnections.filter(item => item.id !== connection.id)
    const normalized = { ...connection, endpoint: new URL(connection.endpoint).href }
    if (search) data.settings.searchConnections.push(normalized as SearchConnection)
    else data.settings.connections.push(normalized as AiConnection)
    if (token !== undefined) {
      data.secrets = Object.fromEntries(Object.entries(data.secrets).filter(([key]) => key !== `ai:${connection.id}`))
      if (token) data.secrets[`ai:${connection.id}`] = JSON.stringify({ endpoint: normalized.endpoint, value: token })
    }
  })
}
export function removeConnection(store: AiStore, id: string, expected: AiConnection | SearchConnection): Promise<void> {
  return store.update(data => {
    const current = [...data.settings.connections, ...data.settings.searchConnections].find(item => item.id === id)
    if (canonical(current ?? null) !== canonical(expected)) throw new Error("This connection changed in another window. Reload it before removing it.")
    data.settings.connections = data.settings.connections.filter(item => item.id !== id)
    data.settings.searchConnections = data.settings.searchConnections.filter(item => item.id !== id)
    data.secrets = Object.fromEntries(Object.entries(data.secrets).filter(([key]) => key !== `ai:${id}`))
    // Explicit references remain broken, never silently switched to a different provider.
  })
}
export function selectModel(store: AiStore, consumer: string | null, selection?: AiSelection): Promise<void> {
  return store.update(data => {
    if (selection) {
      selection = readAiSelection(selection)
      if (!data.settings.connections.some(item => item.id === selection?.connection)) throw new Error("The selected connection was removed")
    }
    if (consumer === null) data.settings.defaultModel = selection
    else {
      data.settings.overrides = Object.fromEntries(Object.entries(data.settings.overrides).filter(([key]) => key !== consumer))
      if (selection) data.settings.overrides[consumer] = selection
    }
  })
}
