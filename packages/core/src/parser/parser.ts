import * as collectors from "../story/collectors"
import { Story } from "@once/core"
import { CacheStore } from "@once/platform-webext"
import { BackComms } from "@once/platform-webext"
import {
  daysAgo,
  humanTime,
  parseHumanTime,
  patternMatches
} from "@once/core"

export function get_parser_for_url(url: string): collectors.StoryParser {
  const parsers = collectors.get_parser()

  for (const i in parsers) {
    const parser = parsers[i]
    let patterns = parser.options.pattern
    if (typeof patterns == "string") {
      patterns = [patterns]
    }
    if (patternMatches(url, patterns)) {
      BackComms.send("menu", "add_type", parser.options.type)
      return parser
    }
  }
}

export function add_all_css_colors(): void {
  const parsers = collectors.get_parser()

  for (const i in parsers) {
    const parser = parsers[i]
    const colors = parser.options.colors
    const br_type = "[" + parser.options.type + "]"
    if (colors && colors[0] != "") {
      const style = document.createElement("style")
      style.classList.add("type_style")
      style.innerHTML = `
      .info[data-type='${br_type}'] .type {
        background-color: ${colors[0]};
        border-color: ${colors[1]};
        color: ${colors[1]};
      }

      .menu_btn[data-type='${br_type}'] {
        background-color: ${colors[0]};
        color: ${colors[1]};
      }
      `
      document.head.append(style)
    }
  }
}

export async function parse_response(
  resp: Response,
  url: string,
  og_url: string
): Promise<Story[]> {
  const parser = get_parser_for_url(og_url)

  if (!parser) {
    throw new Error(`no parser found for: ${og_url}`)
  }

  if (parser.options.collects == "json") {
    try {
      const json_content = await resp.json()
      console.log("got json for ", url, parser, json_content)
      await cache_result(url, [Date.now(), json_content])
      return parser.parse(json_content, url, og_url)
    } catch (parseError) {
      const detail =
        parseError instanceof Error ? parseError.message : String(parseError)
      throw new Error(`JSON parsing failed: ${detail}`)
    }
  } else if (parser.options.collects == "dom") {
    try {
      const text_content = await resp.text()
      await cache_result(url, [Date.now(), text_content])
      const doc = parse_dom(text_content, url)
      return parser.parse(doc, url, og_url)
    } catch (parseError) {
      const detail =
        parseError instanceof Error ? parseError.message : String(parseError)
      throw new Error(`DOM parsing failed: ${detail}`)
    }
  } else if (parser.options.collects == "xml") {
    try {
      const text_content = await resp.text()
      await cache_result(url, [Date.now(), text_content])
      const doc = parse_xml(text_content)
      return parser.parse(doc, url, og_url)
    } catch (parseError) {
      const detail =
        parseError instanceof Error ? parseError.message : String(parseError)
      throw new Error(`XML parsing failed: ${detail}`)
    }
  }
}

export function parse_xml(val: string): Document {
  const dom_parser = new DOMParser()
  let doc = dom_parser.parseFromString(val, "text/xml")

  if (doc.querySelector("parsererror")) {
    const parserError = doc.querySelector("parsererror")
    console.error("xml parser failed", parserError)

    const errorText = parserError?.textContent || "Unknown XML parsing error"

    // Try to fix common XML issues
    const twice = dom_parser.parseFromString(
      val.replace(/ & /g, " &amp; "),
      "text/xml"
    )
    if (!twice.querySelector("parsererror")) {
      doc = twice
    } else {
      throw new Error(`XML parsing failed: ${errorText}`)
    }
  }
  return doc
}

export function parse_dom(val: string, url: string): Document {
  const dom_parser = new DOMParser()
  const doc = dom_parser.parseFromString(val, "text/html")

  if (!doc.querySelector("base")) {
    const base = document.createElement("base")
    base.href = url
    doc.head.append(base)
  } else {
    console.log("base already there", doc.querySelector("base"))
  }

  return doc
}

export function days_ago(timestamp: number): number {
  return daysAgo(timestamp)
}

export function human_time(time: string | Date | number): string {
  return humanTime(time)
}

export function parse_human_time(str: string): number {
  return parseHumanTime(str)
}

async function cache_result(url: string, content: any) {
  try {
    await CacheStore.set(url, content)
  } catch (e) {
    console.log("CacheStore cache issue", e)
  }
}
