// Resolving what an API call aims at: the argument records extensions pass
// and the tab frames a script injection reaches. Shared by the V2 `tabs`
// injection handlers and the V3 `scripting` namespace.

import type { ApiHost } from "./ExtensionApi"
import type { ContextEntry } from "./ExtensionContexts"
import { permittedHosts } from "./extensionPermissions"

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {}
}

export function optionalTabId(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined
}

export function requireTabId(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error("A tab id is required")
  }
  return value
}

export function activeTabId(host: ApiHost): number {
  const active = host.hooks.tabs().find((tab) => tab.active)
  if (!active) throw new Error("There is no active tab")
  return active.id
}

/** The content-script contexts of a tab: one frame, every frame, or the top one. */
export function frameContexts(host: ApiHost, tabId: number, frameId?: number, allFrames = false): ContextEntry[] {
  host.ensureInjectionFrames?.(tabId, frameId, allFrames)
  return host.contexts.all().filter((entry) =>
    entry.kind === "content" && entry.tabId === tabId && !entry.isDestroyed() &&
    (frameId !== undefined ? entry.frameId === frameId : allFrames || entry.frameId === 0)
  )
}

export function canInjectFrame(host: ApiHost, tabId: number, url: string): boolean {
  if (permittedHosts(host.extension).matches(url) || host.hasActiveTabGrant?.(tabId, url)) return true
  if (url !== "about:blank" && url !== "") return false
  const topUrl = host.hooks.tabs().find((tab) => tab.id === tabId)?.url
  return !!topUrl && (permittedHosts(host.extension).matches(topUrl) ||
    !!host.hasActiveTabGrant?.(tabId, topUrl))
}

export function authorizedFrames(host: ApiHost, tabId: number, frames: ContextEntry[]): ContextEntry[] {
  const allowed = frames.filter((frame) => canInjectFrame(host, tabId, frame.url()))
  if (frames.length > 0 && allowed.length === 0) throw new Error("Missing host permission for target frame")
  return allowed
}
