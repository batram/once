// Manifest V3's `scripting` namespace over the machinery behind the V2
// `tabs.executeScript`/`insertCSS` and `contentScripts.register` APIs: an
// injection reaches a tab's frames, a registered script joins the frames
// that match from now on. Registrations live as long as the host does;
// `persistAcrossSessions` is not honoured.

import type { ApiHandler, ApiHost } from "./ExtensionApi"
import { ContextEntry } from "./ExtensionContexts"
import { extensionUrl } from "./ExtensionScheme"
import { asRecord, frameContexts, requireTabId } from "./apiTargets"
import { ContentScript, registeredContentScript } from "./contentScripts"
import { INTERNAL_API } from "./protocol"

const SCRIPT_RESULT_TIMEOUT_MS = 10_000

type Handlers = Record<string, ApiHandler>

interface Registration {
  /** The script as the extension described it, handed back by getRegisteredContentScripts. */
  readonly options: Record<string, unknown>
  /** The host's handle for the compiled script. */
  readonly handle: number
}

const registrations = new WeakMap<ApiHost, Map<string, Registration>>()

function registeredScripts(host: ApiHost): Map<string, Registration> {
  let map = registrations.get(host)
  if (!map) {
    map = new Map()
    registrations.set(host, map)
  }
  return map
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []
}

/** The frames an injection's `target` names: listed ids, every frame, or the top one. */
function targetFrames(host: ApiHost, injection: Record<string, unknown>): ContextEntry[] {
  const target = asRecord(injection.target)
  const tabId = requireTabId(target.tabId)
  if (Array.isArray(target.frameIds)) {
    const wanted = target.frameIds.filter((id): id is number => typeof id === "number")
    return frameContexts(host, tabId, undefined, true).filter((frame) => wanted.includes(frame.frameId))
  }
  return frameContexts(host, tabId, undefined, target.allFrames === true)
}

/** What an executeScript injection runs, in order, with a URL for file sources. */
function scriptSources(host: ApiHost, injection: Record<string, unknown>): { code: string; url?: string }[] {
  const files = stringList(injection.files)
  if (files.length > 0) {
    return files.map((file) => ({ code: host.files.read(file), url: extensionUrl(host.extension.host, file) }))
  }
  // The preload replaced `func` with its source; the arguments arrive cloned.
  if (typeof injection.funcSource === "string") {
    const args = Array.isArray(injection.args) ? injection.args : []
    return [{ code: `(${injection.funcSource}).apply(null, ${JSON.stringify(args)})` }]
  }
  throw new Error("scripting.executeScript needs files or func")
}

function styleSources(host: ApiHost, injection: Record<string, unknown>): string[] {
  if (typeof injection.css === "string") return [injection.css]
  const styles = stringList(injection.files).map((file) => host.files.read(file))
  if (styles.length === 0) throw new Error("scripting.insertCSS needs files or css")
  return styles
}

/** A V3 registration in the shape `contentScripts.register` validates. */
function compileRegistration(options: Record<string, unknown>): ContentScript {
  return registeredContentScript({
    matches: stringList(options.matches),
    excludeMatches: stringList(options.excludeMatches),
    js: stringList(options.js).map((file) => ({ file })),
    css: stringList(options.css).map((file) => ({ file })),
    runAt: options.runAt,
    allFrames: options.allFrames,
    world: options.world
  })
}

function scriptId(options: Record<string, unknown>): string {
  const id = options.id
  if (typeof id !== "string" || id.length === 0 || id.startsWith("_")) {
    throw new Error("scripting: a content script needs an id that does not start with '_'")
  }
  return id
}

function injectionHandlers(): Handlers {
  const sendStyles = (event: "insertCSS" | "removeCSS"): ApiHandler => ({ host }, injection) => {
    const record = asRecord(injection)
    const frames = targetFrames(host, record)
    const styles = styleSources(host, record)
    for (const frame of frames) {
      for (const css of styles) frame.send({ api: INTERNAL_API.content, event, args: [{ css }] })
    }
  }
  return {
    "scripting.executeScript": async ({ host }, injection) => {
      const record = asRecord(injection)
      const frames = targetFrames(host, record)
      const sources = scriptSources(host, record)
      const world = record.world === "MAIN" ? "MAIN" : undefined
      const results: { frameId: number; result: unknown }[] = []
      for (const frame of frames) {
        let result: unknown
        for (const source of sources) {
          [result] = await host.contexts.request(
            { entry: frame, listenerIds: [] },
            INTERNAL_API.content, "executeScript", [{ ...source, world }], SCRIPT_RESULT_TIMEOUT_MS
          )
        }
        results.push({ frameId: frame.frameId, result })
      }
      return results
    },
    "scripting.insertCSS": sendStyles("insertCSS"),
    "scripting.removeCSS": sendStyles("removeCSS")
  }
}

function registrationHandlers(): Handlers {
  const listOf = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.map(asRecord) : []
  return {
    "scripting.registerContentScripts": ({ host }, scripts) => {
      const registered = registeredScripts(host)
      // Validate everything before registering anything, so a bad entry
      // leaves no half-applied batch behind.
      const compiled = listOf(scripts).map((options) => {
        const id = scriptId(options)
        if (registered.has(id)) throw new Error(`Content script with id "${id}" is already registered`)
        return { id, options, script: compileRegistration(options) }
      })
      for (const { id, options, script } of compiled) {
        registered.set(id, { options, handle: host.registerContentScript(script) })
      }
    },
    "scripting.unregisterContentScripts": ({ host }, filter) => {
      const registered = registeredScripts(host)
      const ids = asRecord(filter).ids
      const selected = ids === undefined ? [...registered.keys()] : stringList(ids)
      for (const id of selected) {
        const entry = registered.get(id)
        if (!entry) throw new Error(`Nonexistent script ID '${id}'`)
        host.registeredScripts.delete(entry.handle)
        registered.delete(id)
      }
    },
    "scripting.getRegisteredContentScripts": ({ host }, filter) => {
      const ids = asRecord(filter).ids
      const wanted = ids === undefined ? null : stringList(ids)
      return [...registeredScripts(host).entries()]
        .filter(([id]) => wanted === null || wanted.includes(id))
        .map(([, entry]) => entry.options)
    },
    "scripting.updateContentScripts": ({ host }, scripts) => {
      const registered = registeredScripts(host)
      const compiled = listOf(scripts).map((patch) => {
        const id = scriptId(patch)
        const existing = registered.get(id)
        if (!existing) throw new Error(`Nonexistent script ID '${id}'`)
        const options = { ...existing.options, ...patch }
        return { id, existing, options, script: compileRegistration(options) }
      })
      for (const { id, existing, options, script } of compiled) {
        host.registeredScripts.delete(existing.handle)
        registered.set(id, { options, handle: host.registerContentScript(script) })
      }
    }
  }
}

export function scriptingHandlers(): Handlers {
  return { ...injectionHandlers(), ...registrationHandlers() }
}
