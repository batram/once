// The checks every `browser.*` call and listener registration goes through
// before a handler runs, shared by the hosts' transports: the allowlist in
// `protocol.ts` decides what exists, the manifest decides what is permitted.

import { ApiHandler, ApiHost } from "./ExtensionApi"
import { ContextEntry } from "./ExtensionContexts"
import { requirePermission } from "./extensionPermissions"
import {
  ApiSurface,
  CONTENT_API_SURFACE,
  EXTENSION_API_SURFACE,
  ExtensionInvoke,
  INTERNAL_API,
  ListenerChange
} from "./protocol"
import { WebRequestListenerSpec } from "./webRequestDetails"

/** What a context may call: the page API unless it is a content-script world. */
export function surfaceFor(entry: ContextEntry): Readonly<Record<string, ApiSurface>> {
  return entry.kind === "content" ? CONTENT_API_SURFACE : EXTENSION_API_SURFACE
}

export function invokeApi(
  handlers: Readonly<Record<string, ApiHandler>>,
  host: ApiHost,
  entry: ContextEntry,
  message: ExtensionInvoke,
  surface: Readonly<Record<string, ApiSurface>>
): unknown {
  if (!message || typeof message.api !== "string" || typeof message.method !== "string" ||
    !Array.isArray(message.args)) {
    throw new Error("Invalid extension API call")
  }
  if (message.api !== INTERNAL_API.port) {
    const known = surface[message.api]
    if (!known || !known.methods.includes(message.method)) {
      throw new Error(`browser.${message.api}.${message.method} is not available`)
    }
  }
  const handler = handlers[`${message.api}.${message.method}`]
  if (!handler) throw new Error(`browser.${message.api}.${message.method} is not implemented`)
  return handler({ host, sender: entry }, ...message.args)
}

export function applyListenerChange(
  host: ApiHost,
  entry: ContextEntry,
  change: ListenerChange | undefined,
  surface: Readonly<Record<string, ApiSurface>>
): void {
  if (!change || typeof change.api !== "string" || typeof change.event !== "string" ||
    typeof change.id !== "number") {
    throw new Error("Invalid listener registration")
  }
  const known = surface[change.api]
  if (!known || !known.events.includes(change.event)) {
    throw new Error(`browser.${change.api}.${change.event} is not available`)
  }
  if (change.api === "webRequest") {
    requirePermission(host.extension, "webRequest")
    if (change.action === "add" && change.spec?.extraInfoSpec?.includes("blocking")) {
      requirePermission(host.extension, "webRequestBlocking")
    }
  }
  if (change.action === "add") {
    // The filter's shape is checked where it is compiled; a bad one simply
    // never matches a request.
    const spec = change.spec ? change.spec as WebRequestListenerSpec : null
    host.contexts.addListener(entry.id, change.api, change.event, change.id, spec)
  } else if (change.action === "remove") {
    host.contexts.removeListener(entry.id, change.api, change.event, change.id)
  } else {
    throw new Error("Invalid listener change")
  }
}
