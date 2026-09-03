// The messages between the Once UI and an add-on's sandbox frame. Both sides
// are JSON over postMessage; the host treats everything that arrives as
// untrusted and validates it here before acting.

import { StoryView } from "./storyView"

export const SANDBOX_PROTOCOL = 1

/** How long the host waits before giving up on the sandbox, per request kind. */
export const SANDBOX_TIMEOUTS = Object.freeze({
  loadMs: 5_000,
  invokeMs: 3_000,
  badgesMs: 5_000
})

export const SANDBOX_LIMITS = Object.freeze({
  /** Longest badge text the host will show. */
  badgeText: 60,
  /** Failed loads or crashes before an add-on is left off until settings change. */
  failures: 3,
  /** Add-on code size, in characters. */
  code: 512 * 1024
})

/** Host → sandbox. */
export type HostToSandbox =
  | { type: "load"; protocol: number; addonId: string; code: string; settings: Readonly<Record<string, unknown>> }
  | { type: "invoke"; requestId: number; action: string; story: StoryView }
  | { type: "badges"; requestId: number; contribution: string; stories: readonly StoryView[] }
  | { type: "settings"; settings: Readonly<Record<string, unknown>> }

/** The operations a script may ask of the host. Each names the story it is about. */
export type SandboxOperation =
  | { name: "openUrl"; href: string; url: string; target?: "_self" | "blank" | "middle" }
  | { name: "copyText"; href: string; text: string }
  | { name: "search"; href: string; query: string }
  | { name: "notify"; href: string; text: string }
  | { name: "setReadState"; href: string; state: "unread" | "read" | "skipped" }
  | { name: "toggleBookmark"; href: string }
  | { name: "addTag"; href: string; tag: string }
  | { name: "updateBadge"; href: string; contribution: string; text: string }

/** Sandbox → host. */
export type SandboxToHost =
  | { type: "ready"; protocol: number }
  | { type: "result"; requestId: number; value: unknown }
  | { type: "error"; requestId?: number; message: string }
  | { type: "op"; requestId?: number; op: SandboxOperation }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isText(value: unknown, max = 4096): value is string {
  return typeof value === "string" && value.length <= max
}

function isHref(value: unknown): value is string {
  return isText(value, 4096) && /^https?:\/\//i.test(value)
}

function readOperation(value: unknown): SandboxOperation | null {
  if (!isRecord(value) || !isHref(value.href)) return null
  const href = value.href
  switch (value.name) {
    case "openUrl":
      if (!isHref(value.url)) return null
      if (value.target !== undefined && !["_self", "blank", "middle"].includes(String(value.target))) return null
      return { name: "openUrl", href, url: value.url, target: value.target as "_self" | "blank" | "middle" | undefined }
    case "copyText":
      return isText(value.text) ? { name: "copyText", href, text: value.text } : null
    case "search":
      return isText(value.query, 500) ? { name: "search", href, query: value.query } : null
    case "notify":
      return isText(value.text, 500) ? { name: "notify", href, text: value.text } : null
    case "setReadState":
      return ["unread", "read", "skipped"].includes(String(value.state))
        ? { name: "setReadState", href, state: value.state as "unread" | "read" | "skipped" }
        : null
    case "toggleBookmark":
      return { name: "toggleBookmark", href }
    case "addTag":
      return isText(value.tag, 60) && value.tag.trim() ? { name: "addTag", href, tag: value.tag.trim() } : null
    case "updateBadge":
      return isText(value.contribution, 120) && isText(value.text, SANDBOX_LIMITS.badgeText)
        ? { name: "updateBadge", href, contribution: value.contribution, text: value.text }
        : null
    default:
      return null
  }
}

/** Parses one message from the frame; null for anything malformed. */
export function readSandboxMessage(value: unknown): SandboxToHost | null {
  if (!isRecord(value)) return null
  const requestId = typeof value.requestId === "number" ? value.requestId : undefined
  switch (value.type) {
    case "ready":
      return typeof value.protocol === "number" ? { type: "ready", protocol: value.protocol } : null
    case "result":
      return requestId === undefined ? null : { type: "result", requestId, value: value.value }
    case "error":
      return isText(value.message, 2000) ? { type: "error", requestId, message: value.message } : null
    case "op": {
      const op = readOperation(value.op)
      return op ? { type: "op", requestId, op } : null
    }
    default:
      return null
  }
}

/** Badge results: one text per story asked about, clipped; anything else is empty. */
export function readBadgeTexts(value: unknown, count: number): string[] {
  const list = Array.isArray(value) ? value : []
  return Array.from({ length: count }, (_unused, index) => {
    const text = list[index]
    return typeof text === "string" ? text.slice(0, SANDBOX_LIMITS.badgeText) : ""
  })
}
