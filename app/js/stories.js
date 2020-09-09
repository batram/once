const settings = require("./settings")

module.exports = {
  load,
  reload,
  refilter,
  restar,
  cache_load,
  collect_all_stories,
  sort_stories,
}

let story_map = new Map()

function is_story_read(href) {
  return settings.get_readlist().then((readlist) => {
    return readlist.includes(href)
  })
}

function is_story_stared(href) {
  return settings.get_starlist().then((starlist) => {
    return starlist.hasOwnProperty(href)
  })
}

function add_story(story) {
  story_map.set(story.href.toString(), story)

  //check if we already have story with same URL
  let og_story_el = document.querySelector(
    '.story[data-href="' + story.href + '"]'
  )

  if (og_story_el) {
    // merge story by adding info block, ignore title
    // don't merge on same comment_url, sometimes the same story is on multiple pages
    if (story.comment_url != og_story_el.dataset.comment_url) {
      //avoid adding the same source twice
      if (
        og_story_el.querySelector(
          '.comment_url[href="' + story.comment_url + '"]'
        ) == null
      ) {
        og_story_el.querySelector(".data").appendChild(info_block(story))
      }
    }
    return
  }

  let new_story_el = story_html(story)

  let stories_container = document.querySelector("#stories")
  stories_container.appendChild(new_story_el)
}

function story_html(story) {
  let new_story_el = document.createElement("div")
  new_story_el.classList.add("story")

  if (story.hasOwnProperty("stored_star")) {
    new_story_el.classList.add("stored_star")
  }

  if (story.hasOwnProperty("read")) {
    if (story.read) {
      new_story_el.classList.add("read")
    }
    add_read_button(new_story_el, story)
  } else {
    is_story_read(story.href).then((read) => {
      if (read) {
        new_story_el.classList.add("read")
      }
      add_read_button(new_story_el, story)
    })
  }

  is_story_stared(story.href).then((stared) => {
    if (stared) {
      new_story_el.classList.add("stared")
    }
    add_star_button(new_story_el, story)
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
  outline_btn.onclick = async (x) => {
    sort_stories()
    mark_as_read(story.href)
    web_control.outline(story.href)
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

function add_star_button(new_story_el, story) {
  let star_btn = document.createElement("div")
  star_btn.classList.add("btn")
  star_btn.classList.add("star_btn")
  let star_icon = document.createElement("img")
  star_btn.appendChild(star_icon)

  label_star(new_story_el, star_btn, star_icon)

  star_btn.addEventListener(
    "click",
    (x) => {
      if (!new_story_el.classList.contains("stared")) {
        star_story(story)
      } else {
        unstar_story(story)
      }
      x.preventDefault()
      x.stopPropagation()
      return false
    },
    false
  )
  new_story_el.appendChild(star_btn)
}

function label_star(story_el, btn, icon) {
  if (story_el.classList.contains("stared")) {
    btn.title = "remove bookmark"
    icon.src = "imgs/star_fill.svg"
  } else {
    btn.title = "bookmark"
    icon.src = "imgs/star.svg"
  }
}

function toggle_star(story_el, btn, icon) {
  if (!story_el.classList.contains("stared")) {
    story_el.classList.add("stared")
  } else {
    story_el.classList.remove("stared")
  }
  label_star(story_el, btn, icon)
}

function star_story(story) {
  let story_el = document.querySelector(
    '.story[data-href="' + story.href + '"]'
  )
  let star_btn = story_el.querySelector(".star_btn")
  let star_icon = story_el.querySelector(".star_btn img")

  toggle_star(story_el, star_btn, star_icon)

  settings.get_starlist().then((starlist) => {
    starlist[story.href] = story
    settings.save_starlist(starlist, console.log)
  })
}

function unstar_story(story) {
  let story_el = document.querySelector(
    '.story[data-href="' + story.href + '"]'
  )
  let star_btn = story_el.querySelector(".star_btn")
  let star_icon = story_el.querySelector(".star_btn img")

  toggle_star(story_el, star_btn, star_icon)

  settings.get_starlist().then((starlist) => {
    if (starlist.hasOwnProperty(story.href)) {
      delete starlist[story.href]
      settings.save_starlist(starlist, console.log)
    }
  })
}

function add_read_button(new_story_el, story) {
  let read_btn = document.createElement("div")
  read_btn.classList.add("btn")
  read_btn.classList.add("read_btn")
  let read_icon = document.createElement("img")
  read_btn.appendChild(read_icon)

  toggle_read(new_story_el, read_btn, read_icon)

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

  //open story with middle click on "skip reading"
  read_btn.addEventListener("mousedown", (e) => {
    if (e.button == 1) {
      open_story(e, new_story_el, story)
    }
  })
}

function toggle_read(story_el, read_btn, read_icon) {
  if (!story_el.classList.contains("read")) {
    read_btn.title = "skip reading"
    read_icon.src = "imgs/read.svg"
  } else {
    read_btn.title = "mark as unread"
    read_icon.src = "imgs/unread.svg"
  }
}

function open_story(e, story_el, story) {
  web_control.open_in_webview(e, story)

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
  og_link.addEventListener("click", web_control.open_in_webview)
  info.appendChild(og_link)

  //comments
  let comments_link = document.createElement("a")
  comments_link.classList.add("comment_url")
  comments_link.innerText = " [comments] "
  comments_link.href = story.comment_url
  comments_link.addEventListener("click", web_control.open_in_webview)
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
  read_btn.title = "skip reading"
  read_icon.src = "imgs/read.svg"

  settings.get_readlist().then((readlist) => {
    const index = readlist.indexOf(href)
    if (index > -1) {
      readlist.splice(index, 1)
    }
    settings.save_readlist(readlist, console.log)
  })
}

function sort_raw_stories(stories) {
  return stories.sort(story_compare)
}

function story_compare(a, b) {
  //sort by read first and then timestamp
  if (a.read && !b.read) {
    return 1
  } else if (!a.read && b.read) {
    return -1
  } else if ((a.read && b.read) || (!a.read && !b.read)) {
    if (a.timestamp > b.timestamp) return -1
    if (a.timestamp < b.timestamp) return 1
    return 0
  }
  if (a.timestamp > b.timestamp) return -1
  if (a.timestamp < b.timestamp) return 1
  return 0
}

function sort_stories() {
  //sort by timestamp and read
  let storted = Array.from(document.querySelectorAll(".story"))
    .map((x) => {
      return {
        read: x.classList.contains("read"),
        timestamp: x.dataset.timestamp,
        el: x,
      }
    })
    .sort(story_compare)

  storted.forEach((x) => {
    document.querySelector("#stories").appendChild(x.el)
  })
}

function get_cached(url) {
  let cached = localStorage.getItem(url)
  let max_mins = 5

  try {
    cached = JSON.parse(cached)
    if (!Array.isArray(cached)) {
      throw "cached entry is not Array"
    }
    if (cached.length != 2) {
      throw "cached entry not length 2"
    }
    let mins_old = (Date.now() - cached[0]) / (60 * 1000)
    if (mins_old > max_mins) {
      throw "cached entry out of date " + mins_old
    } else {
      console.log("cached", mins_old, url)
    }
  } catch (e) {
    console.log("cache error: ", e)
    return null
  }

  return cached[1]
}

async function collect_all_stories(urls, try_cache = true) {
  let donso = await Promise.all(
    urls.map(async (url) => {
      return cache_load(url, try_cache)
    })
  )

  let all_stories = sort_raw_stories(
    donso
      .filter((x) => {
        return x != undefined
      })
      .flat()
  )
  all_stories.forEach((story) => {
    add_story(story)
  })

  //add all stored stared stories
  let starlist = await settings.get_starlist()

  for (let href in starlist) {
    if (!story_map.has(href.toString())) {
      let star_story = starlist[href]
      star_story.stared = true
      star_story.stored_star = true
      console.log(story_map, star_story)
      add_story(star_story)
    }
  }

  if (searchfield.value != "") {
    search.search_stories(searchfield.value)
  }
}

async function cache_load(url, try_cache = true) {
  let cached = null
  if (try_cache) {
    cached = get_cached(url)
  }
  if (cached != null) {
    return parse_story_response(cached, url)
  } else {
    return fetch(url).then((x) => {
      if (x.ok) {
        return x.text().then((val) => {
          localStorage.setItem(url, JSON.stringify([Date.now(), val]))
          return parse_story_response(val, url)
        })
      }
    })
  }
}

async function story_enhancers() {
  let enhance = await Promise.all([
    settings.get_readlist(),
    settings.get_starlist(),
  ])
  return enhance
}

async function parse_story_response(val, url) {
  let dom_parser = new DOMParser()
  let doc = dom_parser.parseFromString(val, "text/html")

  if (!doc.querySelector("base")) {
    let base = document.createElement("base")
    base.href = url
    doc.head.append(base)
  } else {
    console.log("base already there", doc.querySelector("base"))
  }

  let stories = story_parser.parse(url, doc)
  let enhance = await story_enhancers()
  let filtered_stories = await filters.filter_stories(stories)
  let readlist = enhance[0]
  let starlist = enhance[0]

  filtered_stories.forEach((story) => {
    story.read = readlist.includes(story.href)
    story.stared = starlist.hasOwnProperty(story.href)
    //add_story(story)
    story_map.set(story.href.toString(), story)
  })

  return filtered_stories
}

async function load(urls) {
  let cache = false
  //TODO: not sure about waiting for all, check out rambazamba mode
  collect_all_stories(urls, cache)
}

async function restar() {
  let starlist = await settings.get_starlist()

  document.querySelectorAll(".story").forEach((story_el) => {
    let sthref = story_el.dataset.href
    if (starlist.hasOwnProperty(sthref)) {
      let nstory = story_html(story_map.get(sthref.toString()))
      story_el.replaceWith(nstory)
    } else {
      if (story_el.classList.contains("stared")) {
        story_el.classList.remove("stared")
        let star_btn = story_el.querySelector(".star_btn")
        let star_icon = story_el.querySelector(".star_btn img")
        label_star(story_el, star_btn, star_icon)
      }
    }
  })
}

function refilter() {
  document.querySelectorAll(".story").forEach((x) => {
    let sthref = x.dataset.href.toString()
    filters.filter_story(story_map.get(sthref.toString())).then((story) => {
      story_map.set(sthref.toString(), story)
      let nstory = story_html(story_map.get(sthref.toString()))
      x.replaceWith(nstory)
    })
  })
}

function reload() {
  story_map = new Map()

  document.querySelectorAll(".story").forEach((x) => {
    x.outerHTML = ""
  })

  settings.story_sources().then(load)
}

reload_stories_btn.onclick = reload
