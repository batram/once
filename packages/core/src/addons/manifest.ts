// The add-on manifest: what an add-on is and what it contributes. This file
// validates protocol 1 manifests and rejects a manifest whole on any error,
// reporting every problem it found so the settings editor can show them.
// Only declarative contributions are accepted yet; a `script` is refused.

import { AddonCondition, CONDITION_KEYS } from "./conditions"
import { isKnownPlaceholder, templatePlaceholders } from "./templates"

export const ADDON_PROTOCOL = 1

export const ADDON_LIMITS = Object.freeze({
  idPattern: /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/,
  contributions: 24,
  label: 60,
  template: 2000,
  iconName: 40,
  conditionValues: 32
})

export type StoryMenuGroup = "navigation" | "state" | "discovery" | "history" | "advanced"
export const STORY_MENU_GROUPS: readonly StoryMenuGroup[] = Object.freeze([
  "navigation", "state", "discovery", "history", "advanced"
])

export type StoryActionSurface = "button" | "menu" | "swipe" | "key"
const SURFACES: readonly StoryActionSurface[] = Object.freeze(["button", "menu", "swipe", "key"])

/** What a declarative action does; exactly one of the keys is present. */
export type AddonRun =
  | { open: string; target?: "_self" | "blank" | "middle" }
  | { copy: string }
  | { search: string }
  | { tag: string }
  | { setReadState: "unread" | "read" | "skipped" }

export interface StoryActionContribution {
  kind: "action"
  id: string
  label: string
  icon?: string
  group: StoryMenuGroup
  surfaces: readonly StoryActionSurface[]
  when?: AddonCondition
  run: AddonRun
}

export interface StoryBadgeContribution {
  kind: "badge"
  id: string
  text: string
  when?: AddonCondition
}

export interface StoryLineContribution {
  kind: "line"
  id: string
  text: string
  when?: AddonCondition
}

export type StoryContribution =
  | StoryActionContribution
  | StoryBadgeContribution
  | StoryLineContribution

export interface AddonManifest {
  protocol: number
  id: string
  name: string
  version: string
  author?: string
  homepage?: string
  contributions: readonly StoryContribution[]
}

export interface AddonReport {
  path: string
  message: string
}

export type AddonManifestRead =
  | { ok: true; manifest: AddonManifest; reports: AddonReport[] }
  | { ok: false; reports: AddonReport[] }

/** Every id Once shows for an add-on's contribution: stable and collision-free. */
export function addonContributionId(addonId: string, localId: string): string {
  return `addon:${addonId}/${localId}`
}

export function isAddonContributionId(value: string): boolean {
  return /^addon:[a-z0-9-]+\/[a-z0-9-]+$/.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

class Reader {
  readonly reports: AddonReport[] = []

  fail(path: string, message: string): undefined {
    this.reports.push({ path, message })
    return undefined
  }

  string(value: unknown, path: string, max: number, required = true): string | undefined {
    if (value === undefined) return required ? this.fail(path, "is required") : undefined
    if (typeof value !== "string") return this.fail(path, "must be a string")
    const trimmed = value.trim()
    if (required && trimmed.length === 0) return this.fail(path, "must not be empty")
    if (trimmed.length > max) return this.fail(path, `is longer than ${max} characters`)
    return trimmed
  }

  template(value: unknown, path: string): string | undefined {
    const text = this.string(value, path, ADDON_LIMITS.template)
    if (text === undefined) return undefined
    const unknown = templatePlaceholders(text).filter((name) => !isKnownPlaceholder(name))
    if (unknown.length > 0) return this.fail(path, `uses unknown placeholders: ${unknown.join(", ")}`)
    return text
  }

  stringList(value: unknown, path: string): string[] | undefined {
    if (!Array.isArray(value)) return this.fail(path, "must be a list of strings")
    if (value.length > ADDON_LIMITS.conditionValues) return this.fail(path, "has too many entries")
    if (!value.every((entry) => typeof entry === "string" && entry.length > 0 && entry.length <= 200)) {
      return this.fail(path, "must be a list of non-empty strings")
    }
    return value as string[]
  }

  condition(value: unknown, path: string): AddonCondition | undefined {
    if (value === undefined) return undefined
    if (!isRecord(value)) return this.fail(path, "must be an object")
    const when: AddonCondition = {}
    for (const key of Object.keys(value)) {
      if (!(CONDITION_KEYS as readonly string[]).includes(key)) {
        this.fail(`${path}.${key}`, "is not a known condition")
        continue
      }
      const raw = value[key]
      const subPath = `${path}.${key}`
      switch (key) {
        case "stared":
        case "hasComments":
          if (typeof raw !== "boolean") this.fail(subPath, "must be true or false")
          else when[key] = raw
          break
        case "readState": {
          const list = this.stringList(raw, subPath)
          if (list && !list.every((state) => ["unread", "read", "skipped"].includes(state))) {
            this.fail(subPath, "must name unread, read, or skipped")
          } else if (list) when.readState = list as AddonCondition["readState"]
          break
        }
        case "field":
          if (!isRecord(raw)) this.fail(subPath, "must be an object")
          else {
            const fields: Record<string, string | number | boolean> = {}
            for (const [name, fieldValue] of Object.entries(raw)) {
              if (["string", "number", "boolean"].includes(typeof fieldValue)) {
                fields[name] = fieldValue as string | number | boolean
              } else this.fail(`${subPath}.${name}`, "must be a string, number, or boolean")
            }
            when.field = fields
          }
          break
        default: {
          const list = this.stringList(raw, subPath)
          if (list) when[key as "type" | "domain" | "notDomain" | "scheme" | "tag"] = list
        }
      }
    }
    return when
  }

  run(value: unknown, path: string): AddonRun | undefined {
    if (!isRecord(value)) return this.fail(path, "must be an object")
    const keys = Object.keys(value).filter((key) => key !== "target")
    if (keys.length !== 1) return this.fail(path, "must have exactly one of open, copy, search, tag, setReadState")
    const [key] = keys
    switch (key) {
      case "open": {
        let open = this.template(value.open, `${path}.open`)
        // The scheme is static text in front of the first placeholder, so it
        // is checked here rather than only when the URL is rendered.
        if (open !== undefined && !/^https?:\/\//i.test(open)) {
          open = this.fail(`${path}.open`, "must start with http:// or https://")
        }
        const target = value.target
        if (target !== undefined && !["_self", "blank", "middle"].includes(String(target))) {
          return this.fail(`${path}.target`, "must be _self, blank, or middle")
        }
        return open === undefined ? undefined : { open, target: target as "_self" | "blank" | "middle" | undefined }
      }
      case "copy":
      case "search": {
        const text = this.template(value[key], `${path}.${key}`)
        return text === undefined ? undefined : key === "copy" ? { copy: text } : { search: text }
      }
      case "tag": {
        const tag = this.string(value.tag, `${path}.tag`, ADDON_LIMITS.label)
        return tag === undefined ? undefined : { tag }
      }
      case "setReadState":
        if (!["unread", "read", "skipped"].includes(String(value.setReadState))) {
          return this.fail(`${path}.setReadState`, "must be unread, read, or skipped")
        }
        return { setReadState: value.setReadState as "unread" | "read" | "skipped" }
      default:
        return this.fail(path, `${key} is not a known run`)
    }
  }

  contribution(value: unknown, path: string): StoryContribution | undefined {
    if (!isRecord(value)) return this.fail(path, "must be an object")
    const id = this.string(value.id, `${path}.id`, 40)
    if (id !== undefined && !ADDON_LIMITS.idPattern.test(id)) {
      this.fail(`${path}.id`, "must be 3–40 lower-case letters, digits, or dashes")
    }
    const when = this.condition(value.when, `${path}.when`)
    switch (value.kind) {
      case "action": {
        const label = this.string(value.label, `${path}.label`, ADDON_LIMITS.label)
        const icon = this.string(value.icon, `${path}.icon`, ADDON_LIMITS.iconName, false)
        const group = value.group === undefined ? "navigation" : value.group
        if (!(STORY_MENU_GROUPS as readonly unknown[]).includes(group)) {
          this.fail(`${path}.group`, `must be one of ${STORY_MENU_GROUPS.join(", ")}`)
        }
        const surfaces = value.surfaces === undefined ? ["button", "menu"] : value.surfaces
        if (!Array.isArray(surfaces) || surfaces.length === 0 ||
          !surfaces.every((surface) => (SURFACES as readonly unknown[]).includes(surface))) {
          this.fail(`${path}.surfaces`, `must list some of ${SURFACES.join(", ")}`)
        }
        const run = this.run(value.run, `${path}.run`)
        if (id === undefined || label === undefined || run === undefined) return undefined
        return {
          kind: "action", id, label, icon, group: group as StoryMenuGroup,
          surfaces: [...new Set(surfaces as StoryActionSurface[])], when, run
        }
      }
      case "badge":
      case "line": {
        const text = this.template(value.text, `${path}.text`)
        if (id === undefined || text === undefined) return undefined
        return { kind: value.kind, id, text, when }
      }
      default:
        return this.fail(`${path}.kind`, "must be action, badge, or line")
    }
  }
}

/** Validates one manifest. Never throws; a manifest is accepted whole or not at all. */
export function readAddonManifest(value: unknown): AddonManifestRead {
  const reader = new Reader()
  if (!isRecord(value)) return { ok: false, reports: [{ path: "", message: "manifest must be an object" }] }
  if (value.protocol !== ADDON_PROTOCOL) {
    reader.fail("protocol", `must be ${ADDON_PROTOCOL}`)
  }
  if (value.script !== undefined && value.script !== null) {
    reader.fail("script", "scripted add-ons are not supported yet")
  }
  const id = reader.string(value.id, "id", 40)
  if (id !== undefined && !ADDON_LIMITS.idPattern.test(id)) {
    reader.fail("id", "must be 3–40 lower-case letters, digits, or dashes")
  }
  const name = reader.string(value.name, "name", ADDON_LIMITS.label)
  const version = reader.string(value.version, "version", 32)
  const author = reader.string(value.author, "author", ADDON_LIMITS.label, false)
  const homepage = reader.string(value.homepage, "homepage", ADDON_LIMITS.template, false)
  if (homepage !== undefined && !/^https?:\/\//.test(homepage)) reader.fail("homepage", "must be http(s)")

  const contributions: StoryContribution[] = []
  if (!Array.isArray(value.contributions)) {
    reader.fail("contributions", "must be a list")
  } else if (value.contributions.length > ADDON_LIMITS.contributions) {
    reader.fail("contributions", `has more than ${ADDON_LIMITS.contributions} entries`)
  } else {
    const seen = new Set<string>()
    value.contributions.forEach((entry, index) => {
      const contribution = reader.contribution(entry, `contributions[${index}]`)
      if (!contribution) return
      if (seen.has(contribution.id)) reader.fail(`contributions[${index}].id`, "is used twice")
      seen.add(contribution.id)
      contributions.push(contribution)
    })
  }
  if (reader.reports.length > 0 || id === undefined || name === undefined || version === undefined) {
    return { ok: false, reports: reader.reports }
  }
  return {
    ok: true,
    reports: [],
    manifest: { protocol: ADDON_PROTOCOL, id, name, version, author, homepage, contributions }
  }
}
