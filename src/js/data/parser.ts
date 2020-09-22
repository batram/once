import * as menu from "../view/menu"
import * as collectors from "../data/collectors"
import { Story } from "./Story"

export {
  parse,
  human_time,
  parse_human_time,
  get_parser_for_url,
  parse_dom,
  parse_response,
}

function get_parser_for_url(url: string): collectors.StoryParser {
  const parsers = collectors.get_parser()

  for (const i in parsers) {
    const parser = parsers[i]
    if (pattern_matches(url, parser.options.pattern)) {
      menu.add_tag(parser.options.tag, parser.options.colors)
      return parser
    }
  }
}

async function parse_response(resp: Response, url: string): Promise<Story[]> {
  const parser = get_parser_for_url(url)

  if (!parser) {
    throw "no parser found for: " + url
  }

  if (parser.options.collects == "json") {
    const json_content = await resp.json()
    console.log("got json for ", url, parser, json_content)
    localStorage.setItem(url, JSON.stringify([Date.now(), json_content]))
    return parser.parse(json_content)
  } else if (parser.options.collects == "dom") {
    const text_content = await resp.text()
    localStorage.setItem(url, JSON.stringify([Date.now(), text_content]))
    const doc = parse_dom(text_content, url)
    return parser.parse(doc)
  }
}

function pattern_matches(url: string, pattern: string) {
  if (pattern.includes("*")) {
    const split = pattern.split("*")
    if (split.length != 2) {
      throw "For now only one wildcard * is allowd ..."
    }

    return url.startsWith(split[0]) && url.endsWith(split[1])
  }
  return url.startsWith(pattern)
}

function parse_dom(val: string, url: string): Document {
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

function parse(url: string, doc: Document): Story[] {
  const parsers = collectors.get_parser()

  for (const i in parsers) {
    const parser = parsers[i]
    if (url.startsWith(parser.options.pattern)) {
      menu.add_tag(parser.options.tag, parser.options.colors)
      return parser.parse(doc)
    }
  }
}

const min_off = 60
const hour_off = 60 * min_off
const day_off = 24 * hour_off
const month_off = 30 * day_off
const year_off = 365 * day_off

function human_time(time: string | Date | number): string {
  const now = Date.now()
  const timestamp = parseInt(time.toString())
  const offset = (now - timestamp) / 1000
  let res = "?"

  if (offset < min_off) {
    res = "seconds ago"
  } else if (offset < hour_off) {
    const mins = Math.round(offset / min_off)
    if (mins <= 1) {
      res = "1 minute ago"
    } else {
      res = mins + " minutes ago"
    }
  } else if (offset < day_off) {
    const hour = Math.round(offset / hour_off)
    if (hour <= 1) {
      res = "1 hour ago"
    } else {
      res = hour + " hours ago"
    }
  } else if (offset < month_off) {
    const day = Math.round(offset / day_off)
    if (day <= 1) {
      res = "1 day ago"
    } else {
      res = day + " days ago"
    }
  } else if (offset < year_off) {
    const month = Math.round(offset / month_off)
    if (month <= 1) {
      res = "1 month ago"
    } else {
      res = month + " months ago"
    }
  } else {
    if (offset / year_off <= 1) {
      res = "1 year ago"
    } else {
      res = Math.round(offset / year_off) + " years ago"
    }
  }

  return res
}

function parse_human_time(str: string): number {
  const now = Date.now()
  const num = parseInt(str)
  let offset = 0

  if (str.includes("minute")) {
    offset = min_off * 1000 * num
  } else if (str.includes("hour")) {
    offset = hour_off * 1000 * num
  } else if (str.includes("day")) {
    offset = day_off * 1000 * num
  } else if (str.includes("month")) {
    offset = month_off * 1000 * num
  } else if (str.includes("year")) {
    offset = year_off * 1000 * num
  }

  return now - offset
}
