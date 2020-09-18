import * as menu from "../view/menu"
import * as collectors from "../data/collectors"

export { parse, human_time, parse_human_time }

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
