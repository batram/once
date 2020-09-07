const { open_in_webview, outline } = require("./web_control")

module.exports = {
  load,
  reload,
  refilter,
  cache_load,
}

let story_map = new Map()

function is_story_read(href) {
  return settings.get_readlist().then((readlist) => {
    return readlist.includes(href)
  })
}

function add_story(story) {
  story_map[story.comment_url] = story

  filters.filter_story(story).then((story) => {
    //check if we already have story with same URL
    let og_story_el = document.querySelector(
      '.story[data-href="' + story.href + '"]'
    )

    if (og_story_el) {
      // merge story by adding info block, ignore title
      // don't merge on same comment_url, sometimes the same story is on multiple pages
      if (story.comment_url != og_story_el.dataset.comment_url) {
        og_story_el.querySelector(".data").appendChild(info_block(story))
      }
      return
    }

    let new_story_el = story_html(story)

    let stories_container = document.querySelector("#stories")
    stories_container.appendChild(new_story_el)
  })
}

function story_html(story) {
  let new_story_el = document.createElement("div")
  new_story_el.classList.add("story")

  is_story_read(story.href).then((read) => {
    if (read) {
      new_story_el.classList.add("read")
      sort_stories()
    }
    add_read_button(new_story_el, story)
  })

  new_story_el.dataset.title = story.title
  new_story_el.dataset.href = story.href
  new_story_el.dataset.hostname = story.hostname
  new_story_el.dataset.timestamp = story.timestamp
  new_story_el.dataset.type = "[" + story.type + "]"
  new_story_el.dataset.comment_url = story.comment_url

  let title_line = document.createElement("div")
  title_line.classList.add("title_line")

  let link = document.createElement("a")
  link.href = story.href
  link.classList.add("title")
  link.innerText = story.title
  title_line.appendChild(link)

  let hostname = document.createElement("p")
  hostname.classList.add("hostname")
  hostname.innerText = " (" + link.hostname + ") "
  title_line.appendChild(hostname)

  let info = info_block(story)

  let data = document.createElement("div")
  document.createElement("data")
  data.classList.add("data")

  data.appendChild(title_line)
  data.appendChild(info)

  new_story_el.appendChild(data)

  let filter_btn = document.createElement("div")
  filter_btn.classList.add("btn")
  filter_btn.classList.add("filter_btn")
  let filter_icon = document.createElement("img")
  filter_icon.src = "imgs/filter.svg"
  filter_btn.appendChild(filter_icon)
  filter_btn.title = "filter"
  if (story.filter) {
    filter_btn.title = "filtered"
    new_story_el.classList.add("filtered")
    let dinp = document.createElement("input")
    dinp.type = "text"
    dinp.value = story.filter
    dinp.disabled = true
    dinp.style.cursor = "pointer"
    filter_btn.prepend(dinp)
    filter_btn.style.borderColor = "red"
  }
  filter_btn.onclick = (x) => {
    filters.show_filter_dialog(x, filter_btn, story)
  }
  new_story_el.appendChild(filter_btn)

  let outline_btn = document.createElement("div")
  outline_btn.classList.add("btn")
  outline_btn.classList.add("outline_btn")
  let outline_icon = document.createElement("img")
  outline_icon.src = "imgs/article.svg"
  outline_btn.appendChild(outline_icon)
  outline_btn.title = "outline"
  outline_btn.onclick = (x) => {
    mark_as_read(story.href)
    outline(story.href)
  }
  new_story_el.appendChild(outline_btn)

  new_story_el.addEventListener(
    "contextmenu",
    (e) => {
      contextmenu.story_menu(e, story)
    },
    false
  )
  link.addEventListener(
    "click",
    (e) => {
      open_story(e, new_story_el, story)
    },
    false
  )

  return new_story_el
}

function add_read_button(new_story_el, story) {
  let read_btn = document.createElement("div")
  read_btn.classList.add("btn")
  read_btn.classList.add("read_btn")
  let read_icon = document.createElement("img")
  read_btn.appendChild(read_icon)

  toogle_read(new_story_el, read_btn, read_icon)

  read_btn.addEventListener(
    "click",
    (x) => {
      if (!new_story_el.classList.contains("read")) {
        mark_as_read(story.href)
      } else {
        mark_as_unread(story.href)
      }
      x.preventDefault()
      x.stopPropagation()
      sort_stories()

      return false
    },
    false
  )
  new_story_el.appendChild(read_btn)

  //open story with middle click on "mark as read"
  read_btn.addEventListener("mousedown", (e) => {
    if (e.button == 1) {
      open_story(e, new_story_el, story)
    }
  })
}

function toogle_read(story_el, read_btn, read_icon) {
  if (!story_el.classList.contains("read")) {
    read_btn.title = "mark as read"
    read_icon.src = "imgs/read.svg"
  } else {
    read_btn.title = "mark as unread"
    read_icon.src = "imgs/unread.svg"
  }
}

function open_story(e, story_el, story) {
  open_in_webview(e, story)

  document.querySelectorAll(".story").forEach((x) => {
    x.classList.remove("selected")
  })
  story_el.classList.add("selected")
  sort_stories()
  mark_as_read(story.href)
}

function info_block(story) {
  let info = document.createElement("div")
  info.classList.add("info")
  let type = document.createElement("p")
  type.classList.add("tag")
  type.innerText = story.type
  type.style.backgroundColor = story.colors[0]
  type.style.borderColor = story.colors[1]
  type.style.color = story.colors[1]
  info.appendChild(type)

  let og_link = document.createElement("a")
  og_link.innerText = " [OG] "
  og_link.href = story.href
  og_link.addEventListener("click", open_in_webview)
  info.appendChild(og_link)

  //comments
  let comments_link = document.createElement("a")
  comments_link.innerText = " [comments] "
  comments_link.href = story.comment_url
  comments_link.addEventListener("click", open_in_webview)
  info.appendChild(comments_link)

  info.appendChild(document.createTextNode("  " + story.time_str + "  "))

  return info
}

function mark_as_read(href) {
  let story_el = document.querySelector('.story[data-href="' + href + '"]')
  let read_btn = story_el.querySelector(".read_btn")
  let read_icon = story_el.querySelector(".read_btn img")

  story_el.classList.add("read")
  read_btn.title = "mark as unread"
  read_icon.src = "imgs/unread.svg"

  settings.get_readlist().then((readlist) => {
    readlist.push(href)
    readlist = readlist.filter((v, i, a) => a.indexOf(v) === i)
    settings.save_readlist(readlist, console.log)
  })
}

function mark_as_unread(href) {
  let story_el = document.querySelector('.story[data-href="' + href + '"]')
  let read_btn = story_el.querySelector(".read_btn")
  let read_icon = story_el.querySelector(".read_btn img")

  story_el.classList.remove("read")
  read_btn.title = "mark as read"
  read_icon.src = "imgs/read.svg"

  settings.get_readlist().then((readlist) => {
    const index = readlist.indexOf(href)
    if (index > -1) {
      readlist.splice(index, 1)
    }
    settings.save_readlist(readlist, console.log)
  })
}

function sort_stories() {
  //sort by timestamp
  let storted = Array.from(document.querySelectorAll(".story")).sort((a, b) => {
    var a_time = a.dataset.timestamp
    var b_time = b.dataset.timestamp
    var a_read = a.classList.contains("read")
    var b_read = b.classList.contains("read")
    if (a_read && !b_read) {
      return 1
    } else if (!a_read && b_read) {
      return -1
    } else if ((a_read && b_read) || (!a_read && !b_read)) {
      if (a_time > b_time) return -1
      if (a_time < b_time) return 1
      return 0
    }
    if (a_time > b_time) return -1
    if (a_time < b_time) return 1
    return 0
  })

  storted.forEach((x) => {
    document.querySelector("#stories").appendChild(x)
  })
}

function cache_load(urls) {
  urls.forEach((url) => {
    let cache = localStorage.getItem(url)
    try {
      cache = JSON.parse(cache)
    } catch (e) {
      cache = null
    }
    if (
      cache != null &&
      Array.isArray(cache) &&
      cache.length == 2 &&
      Date.now() - cache[0] < 5 * 60 * 1000 //5min?
    ) {
      console.log("cache", (Date.now() - cache[0]) / (60 * 1000))
      parse_story_response(cache[1], url)
    } else {
      console.log("nocache", (Date.now() - cache[0]) / (60 * 1000))
      fetch(url).then((x) => {
        if (x.ok) {
          x.text().then((val) => {
            localStorage.setItem(url, JSON.stringify([Date.now(), val]))
            parse_story_response(val, url)
          })
        }
      })
    }
  })
}

function parse_story_response(val, url) {
  let dom_parser = new DOMParser()
  let doc = dom_parser.parseFromString(val, "text/html")

  let stories = story_parser.parse(url, doc)

  stories.forEach((x) => {
    add_story(x)
  })

  sort_stories()
  search.search_stories(searchfield.value)
}

function load(urls) {
  urls.forEach((url) => {
    fetch(url).then((x) => {
      if (x.ok) {
        x.text().then((val) => {
          parse_story_response(val, url)
        })
      }
    })
  })
}

function refilter() {
  document.querySelectorAll(".story").forEach((x) => {
    let curl = x.dataset.comment_url
    filters.filter_story(story_map[curl]).then((story) => {
      story_map[curl] = story
      let nstory = story_html(story_map[curl])
      x.replaceWith(nstory)
    })
  })
}

function reload() {
  story_map = new Map()

  document.querySelectorAll(".story").forEach((x) => {
    x.outerHTML = ""
  })
  settings.story_sources().then((x) => {
    load(x)
  })
}

reload_stories_btn.onclick = (x) => {
  reload()
}
