module.exports = {
  parse,
  human_time,
}

const { Story } = require("./data/Story")
const menu = require("./menu")

let parsers = {
  "https://news.ycombinator.com/": {
    fun: parse_hn,
    tag: "HN",
    colors: ["rgba(255, 102, 0, 0.56)", "white"],
  },
  "https://lobste.rs/": {
    fun: parse_lob,
    tag: "LO",
    colors: ["rgba(143, 0, 0, 0.56)", "white"],
  },
  "https://old.reddit.com/": {
    fun: parse_reddit_rss,
    tag: "re",
    colors: ["#cee3f8", "black"],
  },
}

function parse(url, doc) {
  for (pattern in parsers) {
    if (url.startsWith(pattern)) {
      let parser = parsers[pattern]
      menu.add_tag(parser.tag, parser.colors)
      return parser.fun(doc, parser.tag)
    }
  }
}

let min_off = 60
let hour_off = 60 * min_off
let day_off = 24 * hour_off
let month_off = 30 * day_off
let year_off = 365 * day_off

function parse_hn_time(str) {
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

function human_time(time) {
  let now = Date.now()
  let timestamp = parseInt(time)
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

function parse_hn(doc, type) {
  let curl = "https://news.ycombinator.com/item?id="
  let stories = Array.from(doc.querySelectorAll(".storylink"))

  return stories.map((story_el) => {
    let pawpaw = story_el.parentElement.parentElement
    let id = pawpaw.id
    if (story_el.protocol == "file:") {
      story_el.href = curl + id
    }

    let time = pawpaw.nextElementSibling.querySelector(".age a").innerText
    let timestamp = parse_hn_time(time)

    //filter ads
    let filter = null
    if (
      story_el.parentElement.parentElement.querySelector(".votelinks") == null
    ) {
      filter = ":: HN ads ::"
    }

    return new Story(
      type,
      story_el.href,
      story_el.innerText,
      curl + id,
      timestamp,
      filter
    )
  })
}

function parse_lob(doc, type) {
  let curl = "https://lobste.rs/s/"
  let stories = Array.from(doc.querySelectorAll(".story"))

  return stories.map((story) => {
    let id = story.dataset.shortid
    let link = story.querySelector(".u-url")
    if (link.protocol == "file:") {
      link.href = curl + id
    }

    let timestamp = Date.parse(story.querySelector(".byline span").title)

    return new Story(type, link.href, link.innerText, curl + id, timestamp)
  })
}

function parse_reddit_rss(doc, type) {
  //Parse as RSS and not HTML ...
  let stories = doc.querySelectorAll("entry")

  return Array.from(stories).map((story) => {
    let dom_parser = new DOMParser()
    let content = dom_parser.parseFromString(
      story.querySelector("content").innerText,
      "text/html"
    )

    let timestamp = Date.parse(story.querySelector("updated").innerText)

    return new Story(
      type,
      content.querySelector("span a").href,
      story.querySelector("title").innerText,
      story.querySelector("link").href,
      timestamp
    )
  })
}
