import { isExtensionPageSender, isTabContentSender } from "./messageSender"

/** Background ownership directory. A reader connects to one selected panel, never broadcasts work. */
export function installReaderAiRouting(browserApi: typeof browser): () => void {
  const owners = new Map<string, { windowId: number; port: browser.runtime.Port }>()
  const connect = (port: browser.runtime.Port) => {
    if (port.name !== "once-reader-ai-host" || !port.sender || !isExtensionPageSender(browserApi, port.sender, "sidepanel")) return
    let owner = ""
    port.onMessage.addListener((message: { owner?: unknown; windowId?: unknown }) => {
      if (typeof message?.owner !== "string" || !/^[a-f0-9-]{36}$/.test(message.owner) || !Number.isInteger(message.windowId)) return
      owner = message.owner; owners.set(owner, { windowId: Number(message.windowId), port })
    })
    port.onDisconnect.addListener(() => { if (owners.get(owner)?.port === port) owners.delete(owner) })
  }
  const message = (request: { onceCommand?: string }, sender: browser.runtime.MessageSender) => {
    if (request?.onceCommand !== "readerAiOwner") return undefined
    if (!isTabContentSender(sender) && !isExtensionPageSender(browserApi, sender, "reader")) return undefined
    const selected = [...owners].find(([, owner]) => owner.windowId === sender.tab?.windowId)
    return Promise.resolve(selected?.[0] ?? null)
  }
  browserApi.runtime.onConnect.addListener(connect)
  browserApi.runtime.onMessage.addListener(message)
  return () => { browserApi.runtime.onConnect.removeListener(connect); browserApi.runtime.onMessage.removeListener(message); owners.clear() }
}
