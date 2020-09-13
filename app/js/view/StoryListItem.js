const { Story } = require("../data/Story")
const { resort_single } = require("./StoryList")
const story_parser = require("../parser")
const filters = require("../filters")
const { ipcRenderer } = require("electron")
const web_control = require("../web_control")

module.exports = {
  story_html,
  info_block,
}

function story_html(story, ipc = false) {
  if (!(story instanceof Story)) {
    story = Story.from_obj(story)
  }

  let story_el = document.createElement("div")
  story_el.classList.add("story")
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

  let og_link = document.createElement("a")
  og_link.innerText = " [OG] "
  og_link.href = story.href
  og_link.addEventListener("click", click_webview)
  title_line.appendChild(og_link)

  let hostname = document.createElement("p")
  hostname.classList.add("hostname")
  hostname.innerText = " (" + link.hostname + ") "
  title_line.appendChild(hostname)

  let sources = document.createElement("div")
  sources.classList.add("sources")
  story.sources.forEach((x) => {
    sources.append(info_block(x))
  })

  let data = document.createElement("div")
  document.createElement("data")
  data.classList.add("data")

  data.appendChild(title_line)
  data.appendChild(sources)

  story_el.appendChild(data)

  add_read_button(story_el, story)
  add_star_button(story_el, story)

  update_read(story.read, story_el)
  story.is_stared().then((stared) => {
    update_star(stared, story_el)
  })

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
  story_el.appendChild(filter_btn)

  let outline_btn = icon_button("outline", "outline_btn", "imgs/article.svg")
  story_el.appendChild(outline_btn)

  if (!ipc) {
    direct_events(story, story_el)
  } else {
    ipc_events(story, story_el)
  }

  return story_el
}

function update_storyel(e, story_el) {
  if (e.detail.value instanceof Story && e.detail.name) {
    switch (e.detail.name) {
      //TODO diff class before after, or completley redraw or fix on-change
      case "star":
      case "unstar":
        update_star(e.detail.value.stared, story_el)
        break
      case "mark_as_read":
      case "open_in_webview":
        update_read(e.detail.value, story_el)
        break
    }
  } else if (e.detail.path.length == 2) {
    switch (e.detail.path[1]) {
      case "read":
        update_read(e.detail.value, story_el)
        break
      case "sources":
        update_sources(e.detail.value, story_el)
        break
      case "stared":
        update_star(e.detail.value, story_el)
        break
      case "filter":
        break
    }
  }
}

function direct_events(story, story_el) {
  story_el.addEventListener("change", (e) => {
    update_storyel(e, story_el)
  })

  let link = story_el.querySelector(".title")
  link.addEventListener("click", click_webview, false)

  let filter_btn = story_el.querySelector(".filter_btn")
  filter_btn.onclick = (x) => {
    filters.show_filter_dialog(x, filter_btn, story)
  }

  let outline_btn = story_el.querySelector(".outline_btn")
  outline_btn.onclick = (x) => {
    web_control.outline(story.href)
  }

  let read_btn = story_el.querySelector(".read_btn")
  read_btn.addEventListener("click", (x) => {
    const { resort_single } = require("./StoryList")
    toggle_read(story.href, resort_single)
  })

  //open story with middle click on "skip reading"
  read_btn.addEventListener("mousedown", (e) => {
    if (e.button == 1) {
      return click_webview(e)
    }
  })

  let star_btn = story_el.querySelector(".star_btn")
  star_btn.addEventListener("click", (_) => {
    if (story.stared) {
      story.unstar()
    } else {
      story.star()
    }
  })
}

function ipc_events(story, story_el) {
  story_el.addEventListener("change", (e) => {
    update_storyel(e, story_el)
  })

  let link = story_el.querySelector(".title")
  link.addEventListener("click", click_webview, false)

  let filter_btn = story_el.querySelector(".filter_btn")
  filter_btn.onclick = (x) => {
    filters.show_filter_dialog(x, filter_btn, story)
  }

  let outline_btn = story_el.querySelector(".outline_btn")
  outline_btn.onclick = (x) => {
    web_control.outline(story.href)
  }

  let read_btn = story_el.querySelector(".read_btn")
  read_btn.addEventListener("click", (x) => {
    ipcRenderer.send("update_story", {
      href: story.href,
      path: "read",
      value: !story.read,
    })
  })

  //open story with middle click on "skip reading"
  read_btn.addEventListener("mousedown", (e) => {
    if (e.button == 1) {
      return click_webview(e)
    }
  })

  let star_btn = story_el.querySelector(".star_btn")
  star_btn.addEventListener("click", (_) => {
    ipcRenderer.send("update_story", {
      href: story.href,
      path: "stared",
      value: !story.stared,
    })
  })
}

function info_block(source_ob) {
  let info = document.createElement("div")
  info.classList.add("info")
  info.dataset.tag = "[" + source_ob.type + "]"
  let type = document.createElement("p")
  type.classList.add("tag")
  type.innerText = source_ob.type
  info.appendChild(type)

  //comments
  let comments_link = document.createElement("a")
  comments_link.classList.add("comment_url")
  comments_link.innerText = " [comments] "
  comments_link.href = source_ob.comment_url
  comments_link.addEventListener("click", click_webview)
  info.appendChild(comments_link)

  info.appendChild(
    document.createTextNode(
      "  " + story_parser.human_time(source_ob.timestamp) + "  "
    )
  )

  return info
}

function click_webview(e) {
  e.preventDefault()
  e.stopPropagation()

  let href = this.href

  if (e.target.href) {
    href = e.target.href
  }

  web_control.open_in_webview(href)

  return false
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

function add_read_button(story_el, story) {
  let read_btn = icon_button("", "read_btn", "")
  story_el.appendChild(read_btn)

  label_read(story_el)
}

function update_read(read, story_el) {
  if (read) {
    story_el.classList.add("read")
  } else {
    story_el.classList.remove("read")
  }
  label_read(story_el)
}

function label_read(story_el) {
  let btn = story_el.querySelector(".read_btn")

  if (!btn) {
    return
  }
  let icon = btn.querySelector("img")

  if (!story_el.classList.contains("read")) {
    btn.title = "skip reading"
    icon.src = "imgs/read.svg"
  } else {
    btn.title = "mark as unread"
    icon.src = "imgs/unread.svg"
  }
}

function toggle_read(href, callback) {
  let story_el = document.querySelector('.story[data-href="' + href + '"]')
  let story = story_loader.story_map.get(href)

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

function add_star_button(story_el, story) {
  if (story.hasOwnProperty("stored_star")) {
    story_el.classList.add("stored_star")
  }

  let star_btn = icon_button("", "star_btn", "")
  story_el.appendChild(star_btn)
  label_star(story_el)
}

function label_star(story_el) {
  let btn = story_el.querySelector(".star_btn")

  if (!btn) {
    return
  }
  let icon = btn.querySelector("img")

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

function update_sources(sources, story_el) {
  let sources_el = story_el.querySelector(".sources")
  sources_el.innerHTML = ""

  sources.forEach((x) => {
    sources_el.append(info_block(x))
  })
}