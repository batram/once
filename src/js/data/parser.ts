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

declare interface StoryParser {
  options: {
    collects: "dom" | "json"
  }
  parse: (content: object | Document) => Story[]
}

function get_parser_for_url(url: string): StoryParser {
  let parsers = collectors.get_parser()

  for (let i in parsers) {
    let parser = parsers[i]
    if (pattern_matches(url, parser.options.pattern)) {
      menu.add_tag(parser.options.tag, parser.options.colors)
      return parser
    }
  }
}

async function parse_response(resp: Response, url: string) {
  let parser = get_parser_for_url(url)

  if (parser.options.collects == "json") {
    let json_content = await resp.json()
    localStorage.setItem(url, JSON.stringify([Date.now(), json_content]))
    return parser.parse(json_content)
  } else if (parser.options.collects == "dom") {
    let text_content = await resp.text()
    localStorage.setItem(url, JSON.stringify([Date.now(), text_content]))
    let doc = parse_dom(text_content, url)
    return parser.parse(doc)
  }
}

function pattern_matches(url: string, pattern: string) {
  if (pattern.includes("*")) {
    let split = pattern.split("*")
    if (split.length != 2) {
      throw "For now only one wildcard * is allowd ..."
    }

    return url.startsWith(split[0]) && url.endsWith(split[1])
  } else {
  }
  return url.startsWith(pattern)
}

function parse_dom(val: string, url: string) {
  let dom_parser = new DOMParser()
  let doc = dom_parser.parseFromString(val, "text/html")

  if (!doc.querySelector("base")) {
    let base = document.createElement("base")
    base.href = url
    doc.head.append(base)
  } else {
    console.log("base already there", doc.querySelector("base"))
  }

  return doc
}

function parse(url: string, doc: Document) {
  let parsers = collectors.get_parser()

  for (let i in parsers) {
    let parser = parsers[i]
    if (url.startsWith(parser.options.pattern)) {
      menu.add_tag(parser.options.tag, parser.options.colors)
      return parser.parse(doc, parser.options.tag)
    }
  }
}

let min_off = 60
let hour_off = 60 * min_off
let day_off = 24 * hour_off
let month_off = 30 * day_off
let year_off = 365 * day_off

function human_time(time: string | Date | number) {
  let now = Date.now()
  let timestamp = parseInt(time.toString())
  let offset = (now - timestamp) / 1000
  let res = "?"

  if (offset < min_off) {
    res = "seconds ago"
  } else if (offset < hour_off) {
    let mins = Math.round(offset / min_off)
    if (mins <= 1) {
      res = "1 minute ago"
    } else {
      res = mins + " minutes ago"
    }
  } else if (offset < day_off) {
    let hour = Math.round(offset / hour_off)
    if (hour <= 1) {
      res = "1 hour ago"
    } else {
      res = hour + " hours ago"
    }
  } else if (offset < month_off) {
    let day = Math.round(offset / day_off)
    if (day <= 1) {
      res = "1 day ago"
    } else {
      res = day + " days ago"
    }
  } else if (offset < year_off) {
    let month = Math.round(offset / month_off)
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

function parse_human_time(str: string) {
  let now = Date.now()
  let num = parseInt(str)
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
