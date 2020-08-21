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
      parsers[pattern](doc)
      break
    }
  }
}

function parse_hn(doc) {
  let curl = "https://news.ycombinator.com/item?id="
  let stories = doc.querySelectorAll(".storylink")
  stories.forEach((x) => {
    let id = x.parentElement.parentElement.id
    if (x.protocol == "file:") {
      x.href = curl + id
    }

    add_story({
      type: "HN",
      href: x.href,
      title: x.innerText,
      comment_url: curl + id,
      colors: ["rgba(255, 102, 0, 0.56)", "white"],
    })
  })
}

function parse_lob(doc) {
  let curl = "https://lobste.rs/s/"
  let stories = doc.querySelectorAll(".u-url")

  stories.forEach((x) => {
    let id =
      x.parentElement.parentElement.parentElement.parentElement.dataset.shortid
    if (x.protocol == "file:") {
      x.href = curl + id
    }

    add_story({
      type: "LO",
      href: x.href,
      title: x.innerText,
      comment_url: curl + id,
      colors: ["rgba(143, 0, 0, 0.56)", "white"],
    })
  })
}
