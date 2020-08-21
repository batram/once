module.exports = {
  parse,
}

let parsers = {
  "https://news.ycombinator.com/": parse_hn,
  "https://lobste.rs/": parse_lob,
}

function parse(url, doc) {
  for (pattern in parsers) {
    if (url.startsWith(pattern)) {
      return parsers[pattern](doc)
    }
  }
}

function parse_hn_time(str) {
  let now = Date.now()
  let num = parseInt(str)
  let offset = 0

  if (str.includes("minute")) {
    offset = 60 * 1000 * num
  } else if (str.includes("hour")) {
    offset = 60 * 60 * 1000 * num
  } else if (str.includes("day")) {
    offset = 24 * 60 * 60 * 1000 * num
  } else if (str.includes("month")) {
    //yes a month has 30 days deal with it :D
    offset = 30 * 24 * 60 * 60 * 1000 * num
  } else if (str.includes("year")) {
    //ingore all that leaping
    offset = 365 * 30 * 24 * 60 * 60 * 1000 * num
  }

  return now - offset
}

function parse_hn(doc) {
  let curl = "https://news.ycombinator.com/item?id="
  let stories = doc.querySelectorAll(".storylink")

  return Array.from(stories).map((story) => {
    let pawpaw = story.parentElement.parentElement
    let id = pawpaw.id
    let time = pawpaw.nextElementSibling.querySelector(".age a").innerText
    if (story.protocol == "file:") {
      story.href = curl + id
    }

    return {
      type: "HN",
      href: story.href,
      title: story.innerText,
      comment_url: curl + id,
      time_str: time,
      timestamp: parse_hn_time(time),
      colors: ["rgba(255, 102, 0, 0.56)", "white"],
    }
  })

}

function parse_lob(doc) {
  let curl = "https://lobste.rs/s/"
  let stories = doc.querySelectorAll(".story")

  return Array.from(stories).map((story) => {
    let id = story.dataset.shortid
    let link = story.querySelector(".u-url")
    if (link.protocol == "file:") {
      link.href = curl + id
    }

    return {
      type: "LO",
      href: link.href,
      title: link.innerText,
      comment_url: curl + id,
      time_str: story.querySelector(".byline span").innerText,
      timestamp: Date.parse(story.querySelector(".byline span").title),
      colors: ["rgba(143, 0, 0, 0.56)", "white"],
    }
  })
}
