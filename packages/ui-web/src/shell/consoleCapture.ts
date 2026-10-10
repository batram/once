export type ConsoleLevel = "error" | "warn" | "uncaught" | "rejection"

export interface ConsoleEntry {
  time: number
  level: ConsoleLevel
  text: string
  /** Which app launch logged it, so earlier launches can be told apart. */
  session: string
}

const STORAGE_KEY = "once:console-log"
const MAX_ENTRIES = 300
const MAX_TEXT = 4000
const SAVE_DELAY = 1000

let installed = false
let entries: ConsoleEntry[] = []
let saveTimer: ReturnType<typeof setTimeout> | undefined
let recording = false
const session = Math.random().toString(36).slice(2, 10)
const listeners = new Set<() => void>()

/**
 * Keeps console errors and warnings, uncaught errors and unhandled
 * rejections, across launches. Libraries report failures this way that never
 * reach the error log (PouchDB's "Database has a global failure", for one), and
 * a release build has no console attached when they happen.
 */
export function installConsoleCapture(): void {
  if (installed || typeof window === "undefined") return
  installed = true
  entries = load()
  for (const level of ["error", "warn"] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      original(...args)
      record(level, args.map(describe).join(" "))
    }
  }
  window.addEventListener("error", (event) => {
    record("uncaught", event.error !== undefined && event.error !== null
      ? describe(event.error)
      : `${event.message} (${event.filename}:${event.lineno}:${event.colno})`)
  })
  window.addEventListener("unhandledrejection", (event) => record("rejection", describe(event.reason)))
  window.addEventListener("pagehide", save)
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") save() })
}

export function consoleEntries(): readonly ConsoleEntry[] {
  return entries
}

export function currentConsoleSession(): string {
  return session
}

export function clearConsoleEntries(): void {
  entries = []
  save()
  notify()
}

export function onConsoleEntries(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function formatConsoleEntry(entry: ConsoleEntry): string {
  return `${new Date(entry.time).toLocaleString()} [${entry.level}] ${entry.text}`
}

function record(level: ConsoleLevel, text: string): void {
  // A listener or storage failure that logs must not record itself forever.
  if (recording) return
  recording = true
  try {
    entries.push({ time: Date.now(), level, text: truncate(text), session })
    if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)
    clearTimeout(saveTimer)
    saveTimer = setTimeout(save, SAVE_DELAY)
    notify()
  } finally {
    recording = false
  }
}

function notify(): void {
  listeners.forEach((listener) => {
    try { listener() } catch { /* a broken view must not break logging */ }
  })
}

function save(): void {
  clearTimeout(saveTimer)
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(entries)) } catch { /* storage is optional */ }
}

function load(): ConsoleEntry[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]")
    return Array.isArray(stored) ? stored.filter(isEntry).slice(-MAX_ENTRIES) : []
  } catch {
    return []
  }
}

function isEntry(value: unknown): value is ConsoleEntry {
  const entry = value as Partial<ConsoleEntry> | null
  return typeof entry?.time === "number" && typeof entry.level === "string" &&
    typeof entry.text === "string" && typeof entry.session === "string"
}

function describe(value: unknown): string {
  if (typeof value === "string") return value
  if (value instanceof Error) {
    const head = `${value.name}: ${value.message}`
    // WebKit's stack omits the message; V8's starts with it.
    const stack = value.stack ? (value.stack.startsWith(head) ? value.stack : `${head}\n${value.stack}`) : head
    const reason = (value as { reason?: unknown }).reason
    return reason === undefined || reason === null ? stack : `${stack}\nreason: ${describe(reason)}`
  }
  if (typeof Event !== "undefined" && value instanceof Event) {
    const error = (value.target as { error?: unknown } | null)?.error
    return error ? `${value.type} event: ${describe(error)}` : `${value.type} event`
  }
  if (value === null || typeof value !== "object") return String(value)
  try {
    return truncate(JSON.stringify(value) ?? String(value))
  } catch {
    return String(value)
  }
}

function truncate(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text
}
