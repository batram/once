import {
  GenySelector,
  GenySelectorConf,
  options as genyOptions,
  sanitize_selector_conf
} from "@once/collectors/geny"

export type PickerFieldKey = "stories" | "link" | "title" | "timestamp" | "tag"
export type PickerSelectorValues = Record<PickerFieldKey, string>

export interface SourceLineState {
  baseConf: GenySelectorConf
  components: Map<PickerFieldKey, string>
  values: PickerSelectorValues
}

function applyFieldSlot(
  conf: GenySelectorConf,
  field: "stories" | "link" | "title" | "timestamp",
  value: string,
  defaults: GenySelector
): void {
  if (!value) conf[field] = undefined
  else if (conf[field]?.sel !== value) conf[field] = { ...defaults, sel: value }
}

export function buildPickerConf(state: SourceLineState): GenySelectorConf {
  const conf = JSON.parse(JSON.stringify(state.baseConf)) as GenySelectorConf
  applyFieldSlot(conf, "stories", state.values.stories, { all: true })
  applyFieldSlot(conf, "link", state.values.link, {
    component: state.components.get("link") || "href"
  })
  applyFieldSlot(conf, "title", state.values.title, {
    component: "innerText",
    processors: ["trim"]
  })
  applyFieldSlot(conf, "timestamp", state.values.timestamp, {
    component: state.components.get("timestamp") || "innerText"
  })

  const baseTagText = conf.tags?.[0]?.elements?.text
  if (!state.values.tag) delete conf.tags
  else if (baseTagText?.sel !== state.values.tag) {
    conf.tags = [{
      elements: {
        text: {
          sel: state.values.tag,
          component: state.components.get("tag") || "innerText"
        }
      }
    }]
  }
  return JSON.parse(JSON.stringify(conf)) as GenySelectorConf
}

export function serializeSourceLine(conf: GenySelectorConf, url: string): string {
  return `geny:${genyOptions.separator}${JSON.stringify(conf)}` +
    `${genyOptions.separator}${url}`
}

export function parseSourceLine(raw: string): {
  state: SourceLineState
  warning: string
} {
  const separator = genyOptions.separator
  const parts = raw.trim().split(separator)
  if (!parts[0].startsWith("geny:") || parts.length < 3) {
    throw new Error(
      `expected geny:${separator}{"stories":…}${separator}https://example.com/…`
    )
  }
  const parsed: unknown = JSON.parse(parts[1])
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("the configuration must be a JSON object")
  }
  const conf = parsed as GenySelectorConf
  const components = new Map<PickerFieldKey, string>()
  const selector = (field: PickerFieldKey, value?: GenySelector): string => {
    if (value?.component) components.set(field, value.component)
    return value?.sel || ""
  }
  const tagText = conf.tags?.[0]?.elements?.text
  const values: PickerSelectorValues = {
    stories: selector("stories", conf.stories),
    link: selector("link", conf.link),
    title: selector("title", conf.title),
    timestamp: selector("timestamp", conf.timestamp),
    tag: selector("tag", tagText)
  }
  let warning = ""
  try {
    sanitize_selector_conf(conf)
  } catch (error) {
    warning = error instanceof Error ? error.message : String(error)
  }
  return { state: { baseConf: conf, components, values }, warning }
}
