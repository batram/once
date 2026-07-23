import { Story } from "@once/core"
import * as collectors from "./registry"

export interface ParserLookupOptions {
  onParserMatched?: (parserType: string) => void
}

export interface ParseResponseOptions extends ParserLookupOptions {
  cacheResult?: (url: string, content: unknown) => Promise<void>
}

export function patternMatches(url: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (pattern.includes("*")) {
      const split = pattern.split("*")
      if (split.length != 2) {
        throw new Error("For now only one wildcard * is allowed in pattern")
      }

      if (url.startsWith(split[0]) && url.endsWith(split[1])) {
        return true
      }
    }
    if (url.startsWith(pattern)) {
      return true
    }
  }

  return false
}

export function get_parser_for_url(
  url: string,
  options: ParserLookupOptions = {}
): collectors.StoryParser | undefined {
  const parsers = collectors.get_parser()

  for (const i in parsers) {
    const parser = parsers[i]
    let patterns = parser.options.pattern
    if (typeof patterns == "string") {
      patterns = [patterns]
    }
    if (patternMatches(url, patterns)) {
      options.onParserMatched?.(parser.options.type)
      return parser
    }
  }

  return undefined
}

export async function parse_response(
  resp: Response,
  url: string,
  og_url: string,
  options: ParseResponseOptions = {}
): Promise<Story[]> {
  const parser = get_parser_for_url(og_url, options)

  if (!parser) {
    throw new Error(`no parser found for: ${og_url}`)
  }

  if (parser.options.collects == "json") {
    try {
      const json_content = await resp.json()
      await cache_result(options, url, [Date.now(), json_content])
      return parser.parse(json_content, url, og_url)
    } catch (parseError) {
      const detail =
        parseError instanceof Error ? parseError.message : String(parseError)
      throw new Error(`JSON parsing failed: ${detail}`)
    }
  } else if (parser.options.collects == "dom") {
    try {
      const text_content = await resp.text()
      await cache_result(options, url, [Date.now(), text_content])
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
      await cache_result(options, url, [Date.now(), text_content])
      const doc = parse_xml(text_content)
      return parser.parse(doc, url, og_url)
    } catch (parseError) {
      const detail =
        parseError instanceof Error ? parseError.message : String(parseError)
      throw new Error(`XML parsing failed: ${detail}`)
    }
  }

  throw new Error(
    `unsupported collects type "${parser.options.collects}" for: ${og_url}`
  )
}

export function parse_xml(val: string): Document {
  const dom_parser = new DOMParser()
  let doc = dom_parser.parseFromString(val, "text/xml")

  if (doc.querySelector("parsererror")) {
    const parserError = doc.querySelector("parsererror")
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
    const base = doc.createElement("base")
    base.href = url
    doc.head.append(base)
  }

  return doc
}

async function cache_result(
  options: ParseResponseOptions,
  url: string,
  content: unknown
) {
  if (!options.cacheResult) {
    return
  }

  try {
    await options.cacheResult(url, content)
  } catch (e) {
    console.log("CacheStore cache issue", e)
  }
}
