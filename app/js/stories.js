const settings = require("./settings")
const story_map = require("./data/StoryMap")
const { Story } = require("./data/Story")

module.exports = {
  load,
  reload,
  refilter,
  restar,
  cache_load,
  collect_all_stories,
  parallel_load_stories,
  enhance_stories,
  sort_stories,
  add_story,
  mark_selected,
}

async function is_story_read(href) {
  const readlist = await settings.get_readlist()
  return readlist.includes(href)
}

async function is_story_stared(href) {
  const starlist = await settings.get_starlist()
  return starlist.hasOwnProperty(href)
}

function add_story(story, bucket = "stories") {
  if (!(story instanceof Story)) {
    let xstory = new Story()
    for (let i in story) {
      xstory[i] = story[i]
    }

    story = xstory
  }
  story.bucket = bucket
  story = story_map.set(story.href.toString(), story)

  //check if we already have story with same URL
  let og_story_el = document.querySelector(
    `#${bucket} .story[data-href="${story.href}"]`
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
        let add_info = info_block(story)
        og_story_el.querySelector(".data").append(add_info)
      }
    }
    return
  }

  let new_story_el = story_html(story)
  let stories_container = document.querySelector("#" + bucket)

  //hide new stories if search is active, will be matched and shown later
  if (searchfield.value != "" && bucket != "global_search_results") {
    new_story_el.classList.add("nomatch")
  }

  stories_container.appendChild(new_story_el)
}

function story_html(story) {
  let story_el = document.createElement("div")
  story_el.classList.add("story")
  story_el.addEventListener("change", (e) => {
    console.log(e.detail)
    if (e.detail.value instanceof Story && e.detail.name) {
      switch (e.detail.name) {
        case "star":
        case "unstar":
          update_star(e.detail.value.stared, story_el)
          break
        case "mark_as_read":
          update_read(e.detail.value, story_el)
          break
      }
    } else if (e.detail.path.length == 2) {
      switch (e.detail.path[1]) {
        case "read":
          update_read(e.detail.value, story_el)
          break
        case "stared":
          update_star(e.detail.value, story_el)
          break
        case "filter":
          break
      }
    }
  })

  story_el.dataset.title = story.title
  story_el.dataset.href = story.href
  story_el.dataset.timestamp = story.timestamp
  story_el.dataset.type = "[" + story.type + "]"
  story_el.dataset.comment_url = story.comment_url

  let title_line = document.createElement("div")
  title_line.classList.add("title_line")

  let link = document.createElement("a")
  link.href = story.href
  link.classList.add("title")
  link.innerText = story.title
  title_line.appendChild(link)

  link.addEventListener(
    "click",
    (e) => {
      return story.open_in_webview(e)
    },
    false
  )

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

  story_el.appendChild(data)

  //buttons
  story.has_or_get(story_el, "read", add_read_button, is_story_read)
  story.has_or_get(story_el, "stared", add_star_button, is_story_stared)
  //         stories.resort_single(story_el)

  let filter_btn = icon_button("filter", "filter_btn", "imgs/filter.svg")
  if (story.filter) {
    filter_btn.title = "filtered"
    story_el.classList.add("filtered")
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
  story_el.appendChild(filter_btn)

  let outline_btn = icon_button("outline", "outline_btn", "imgs/article.svg")
  outline_btn.onclick = (x) => {
    story.mark_as_read()
    web_control.outline(story.href)
  }
  story_el.appendChild(outline_btn)

  return story_el
}

function icon_button(title, classname, icon_src) {
  let btn = document.createElement("div")
  btn.classList.add("btn")
  btn.classList.add(classname)
  let icon = document.createElement("img")
  icon.src = icon_src
  btn.appendChild(icon)
  btn.title = title
  return btn
}

function update_read(read, story_el) {
  if (read) {
    story_el.classList.add("read")
  } else {
    story_el.classList.remove("read")
  }
  label_read(story_el)
}

function mark_selected(story_el, url) {
  if (!story_el && url) {
    let info_can = document.querySelector(`.info a[href="${url}"]`)
    if (info_can) {
      let parent = info_can.parentElement
      let max = 5
      while (!parent.classList.contains("story") && max > 0) {
        max -= 1
        parent = parent.parentElement

        if (parent.classList.contains("story")) {
          story_el = parent
          break
        }
      }
    }
  }

  selected_container.innerHTML = ""

  document.querySelectorAll(".story").forEach((x) => {
    if (x.classList.contains("selected")) {
      x.classList.remove("selected")
      let fun = resort_single(x)
      if (typeof fun == "function") {
        fun()
      }
    }
  })

  if (story_el) {
    //create a cloned story element
    let og_story = story_map.get(story_el.dataset.href)
    let clone = story_html(og_story)
    clone.classList.add("selected")
    story_el.classList.add("selected")
    selected_container.append(clone)
  }
}

function add_star_button(story_el, story) {
  if (story.hasOwnProperty("stored_star")) {
    story_el.classList.add("stored_star")
  }

  let star_btn = icon_button("", "star_btn", "")
  story_el.appendChild(star_btn)
  label_star(story_el)

  star_btn.addEventListener("click", (_) => {
    if (story.stared) {
      story.unstar()
    } else {
      story.star()
    }
  })
}

function label_star(story_el) {
  let btn = story_el.querySelector(".star_btn")
  let icon = btn.querySelector("img")

  if (!btn) {
    return
  }

  if (story_el.classList.contains("stared")) {
    btn.title = "remove bookmark"
    icon.src = "imgs/star_fill.svg"
  } else {
    btn.title = "bookmark"
    icon.src = "imgs/star.svg"
  }
}

function update_star(stared, story_el) {
  if (stared) {
    story_el.classList.add("stared")
  } else {
    story_el.classList.remove("stared")
  }

  label_star(story_el)
}

function add_read_button(story_el, story) {
  let read_btn = icon_button("", "read_btn", "")
  story_el.appendChild(read_btn)

  label_read(story_el)

  read_btn.addEventListener("click", (x) => {
    toggle_read(story.href, resort_single)
  })

  //open story with middle click on "skip reading"
  read_btn.addEventListener("mousedown", (e) => {
    if (e.button == 1) {
      return story.open_in_webview(e)
    }
  })
}

function label_read(story_el) {
  let btn = story_el.querySelector(".read_btn")
  let icon = btn.querySelector("img")

  if (!btn) {
    return
  }

  if (!story_el.classList.contains("read")) {
    btn.title = "skip reading"
    icon.src = "imgs/read.svg"
  } else {
    btn.title = "mark as unread"
    icon.src = "imgs/unread.svg"
  }
}

function info_block(story) {
  let info = document.createElement("div")
  info.classList.add("info")
  info.dataset.tag = "[" + story.type + "]"
  let type = document.createElement("p")
  type.classList.add("tag")
  type.innerText = story.type
  info.appendChild(type)

  let og_link = document.createElement("a")
  og_link.innerText = " [OG] "
  og_link.href = story.href
  og_link.addEventListener("click", (e) => {
    return story.open_in_webview(e)
  })
  info.appendChild(og_link)

  //comments
  let comments_link = document.createElement("a")
  comments_link.classList.add("comment_url")
  comments_link.innerText = " [comments] "
  comments_link.href = story.comment_url
  comments_link.addEventListener("click", (e) => {
    story.open_in_webview(e)
  })
  info.appendChild(comments_link)

  info.appendChild(
    document.createTextNode(
      "  " + story_parser.human_time(story.timestamp) + "  "
    )
  )

  return info
}

function toggle_read(href, callback) {
  let story_el = document.querySelector('.story[data-href="' + href + '"]')
  let story = story_map.get(href)

  let anmim_class = ""

  if (story_el.classList.contains("read")) {
    story_el.classList.remove("read")
    story.remove_from_readlist()
    story.read = false
    anmim_class = "unread_anim"
  } else {
    story_el.classList.add("read")
    story.add_to_readlist()
    story.read = true
    anmim_class = "read_anim"
  }

  label_read(story_el)

  if (typeof callback == "function") {
    let resort = callback(story_el)
    if (typeof resort == "function") {
      if (document.body.classList.contains("animated")) {
        story_el.classList.add(anmim_class)
        story_el.addEventListener("transitionend", resort, false)
      } else {
        resort()
      }
    }
  }
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

function sortable_story(elem) {
  return {
    read: elem.classList.contains("read"),
    timestamp: elem.dataset.timestamp,
    el: elem,
  }
}

function resort_single(elem) {
  let story_con = elem.parentElement
  let stories = Array.from(story_con.querySelectorAll(".story")).filter(
    (el) => {
      return (
        getComputedStyle(el).display != "none" &&
        !el.classList.contains("selected")
      )
    }
  )

  let stories_sorted = stories
    .map(sortable_story)
    .sort(story_compare)
    .map((x) => x.el)

  let insert_before_el = false
  let sorted_pos = stories_sorted.indexOf(elem)

  if (stories.indexOf(elem) == sorted_pos) {
    //don't need to resort, would keep our position
    return false
  } else if (sorted_pos != stories_sorted.length - 1) {
    insert_before_el = stories_sorted[sorted_pos + 1]
  }

  return (x) => {
    if (!insert_before_el) {
      story_con.appendChild(elem)
    } else {
      story_con.insertBefore(elem, insert_before_el)
    }

    if (elem.classList.contains("read_anim")) {
      setTimeout((t) => {
        elem.classList.remove("read_anim")
      }, 1)
    }
    if (elem.classList.contains("unread_anim")) {
      setTimeout((t) => {
        elem.classList.remove("unread_anim")
      }, 1)
    }
  }
}

function sort_stories(bucket = "stories") {
  let story_con = document.querySelector("#" + bucket)

  let storted = Array.from(story_con.querySelectorAll(".story"))
    .map(sortable_story)
    .sort(story_compare)

  storted.forEach((x) => {
    let paw = x.el.parentElement
    paw.appendChild(x.el)
    if (x.el.classList.contains("read_anim")) {
      setTimeout((t) => {
        x.el.classList.remove("read_anim")
      }, 1)
    }
    if (x.el.classList.contains("unread_anim")) {
      setTimeout((t) => {
        x.el.classList.remove("unread_anim")
      }, 1)
    }
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

  process_story_input(
    donso
      .filter((x) => {
        return x != undefined
      })
      .flat()
  )
}

async function parallel_load_stories(urls, try_cache = true) {
  urls.map(async (url) => {
    cache_load(url, try_cache).then(process_story_input)
  })
}

async function process_story_input(stories) {
  let all_stories = sort_raw_stories(stories)
  all_stories.forEach((story) => {
    add_story(story)
  })

  //add all stored stared stories
  let starlist = await settings.get_starlist()
  add_stored_stars(starlist)

  sort_stories()

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

async function enhance_stories(stories) {
  let enhance = await story_enhancers()
  let filtered_stories = await filters.filter_stories(stories)
  let readlist = enhance[0]
  let starlist = enhance[0]

  return filtered_stories.map((story) => {
    story = story_map.set(story.href.toString(), story)
    story.read = readlist.includes(story.href)
    if (starlist.hasOwnProperty(story.href)) {
      story.stared = starlist.hasOwnProperty(story.href)
    }
    return story
  })
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
  return enhance_stories(stories)
}

async function load(urls) {
  let cache = false
  //TODO: not sure about waiting for all, check out rambazamba mode
  parallel_load_stories(urls, cache)
}

async function restar() {
  let starlist = await settings.get_starlist()
  document.querySelectorAll(".story").forEach((story_el) => {
    let sthref = story_el.dataset.href
    let story = story_map.get(sthref.toString())
    story.stared = starlist.hasOwnProperty(sthref)
  })

  add_stored_stars(starrlist)
}

function add_stored_stars(starlist) {
  for (let href in starlist) {
    if (!story_map.has(href.toString())) {
      let star_story = starlist[href]
      star_story.stared = true
      star_story.stored_star = true
      add_story(star_story)
    }
  }
}

function refilter() {
  document.querySelectorAll(".story").forEach((x) => {
    let sthref = x.dataset.href.toString()
    let story = story_map.get(sthref.toString())
    let og_filter = story.filter
    filters.filter_story(story).then((story) => {
      if (story.filter != og_filter) {
        story_map.set(sthref.toString(), story)
        let nstory = story_html(story_map.get(sthref.toString()))
        x.replaceWith(nstory)
      }
    })
  })
}

function reload() {
  story_map.clear()

  document.querySelectorAll(".story").forEach((x) => {
    x.outerHTML = ""
  })

  settings.story_sources().then(load)
}

reload_stories_btn.onclick = reload
