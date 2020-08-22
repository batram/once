module.exports = {
  parse,
}

let parsers = {
  "https://news.ycombinator.com/": parse_hn,
  "https://lobste.rs/": parse_lob,
  "https://old.reddit.com/": parse_reddit_rss,
}

function parse(url, doc) {
  for (pattern in parsers) {
    if (url.startsWith(pattern)) {
      return parsers[pattern](doc)
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

function add_menu_tag(type, colors){
  if(!document.querySelector('#menu div[data-type="' + type + '"]')){
    tag = document.createElement('div')
    tag.dataset.type = type
    tag.classList.add('btn')
    tag.classList.add('menu_btn')
    tag.classList.add('tag')
    tag.classList.add('tag')
    tag.innerText = '[' + type + ']'
    tag.style.backgroundColor = colors[0]
    tag.style.color = colors[1]

    tag.onclick = x => {
      document.querySelector('#searchfield').value = '[' + type + ']'
      search_stories('[' + type + ']')
    }

    document.querySelector('#menu').appendChild(tag)  
  }
}

add_menu_tag("ALL", ["", ""])
add_menu_tag("filtered", ["", ""])
add_menu_tag("new", ["", ""])

function parse_hn(doc) {
  let type = "HN"
  let colors = ["rgba(255, 102, 0, 0.56)", "white"]
  add_menu_tag(type, colors)

  let curl = "https://news.ycombinator.com/item?id="
  let stories = doc.querySelectorAll(".storylink")

  return Array.from(stories).map((story) => {
    let pawpaw = story.parentElement.parentElement
    let id = pawpaw.id
    if (story.protocol == "file:") {
      story.href = curl + id
    }

    let time = pawpaw.nextElementSibling.querySelector(".age a").innerText
    let timestamp = parse_hn_time(time)

    return {
      type: type,
      colors: colors,
      href: story.href,
      hostname: story.hostname,
      title: story.innerText,
      comment_url: curl + id,
      time_str: human_time(timestamp),
      timestamp: timestamp,
    }
  })
}

function parse_lob(doc) {
  let type = "LO"
  let colors = ["rgba(143, 0, 0, 0.56)", "white"]
  add_menu_tag(type, colors)

  let curl = "https://lobste.rs/s/"
  let stories = doc.querySelectorAll(".story")

  return Array.from(stories).map((story) => {
    let id = story.dataset.shortid
    let link = story.querySelector(".u-url")
    if (link.protocol == "file:") {
      link.href = curl + id
    }

    let timestamp = Date.parse(story.querySelector(".byline span").title)

    return {
      type: type,
      colors: colors,
      href: link.href,
      hostname: link.hostname,
      title: link.innerText,
      comment_url: curl + id,
      time_str: human_time(timestamp),
      timestamp: timestamp,
    }
  })
}

function parse_reddit_rss(doc) {
  let type = "re"
  let colors = ["#cee3f8", "black"]
  add_menu_tag(type, colors)

  //Parse as RSS and not HTML ...
  let stories = doc.querySelectorAll("entry")

  return Array.from(stories).map((story) => {
    let dom_parser = new DOMParser()
    let content = dom_parser.parseFromString(
      story.querySelector("content").innerText,
      "text/html"
    )

    let timestamp = Date.parse(story.querySelector("updated").innerText)

    return {
      type: type,
      href: content.querySelector("span a").href,
      hostname: content.querySelector("span a").hostname,
      title: story.querySelector("title").innerText,
      comment_url: story.querySelector("link").href,
      time_str: human_time(timestamp),
      timestamp: timestamp,
      colors: colors,
    }
  })
}
