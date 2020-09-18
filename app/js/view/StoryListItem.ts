import * as story_parser from "../data/parser"
import * as web_control from "../web_control"
import { WebTab } from "../view/webtab"
import * as story_filters from "../data/filters"
import { Story, StorySource } from "../data/Story"
import * as story_map from "../data/StoryMap"
import * as presenters from "../view/presenters"
import * as story_list from "../view/StoryList"

export { story_html, info_block, icon_button }

function story_html(story: Story, inmain = true, webtab?: WebTab) {
  if (!(story instanceof Story)) {
    story = Story.from_obj(story)
  }

  let story_el = document.createElement("div")
  story_el.classList.add("story")
  story_el.dataset.title = story.title
  story_el.dataset.href = story.href
  story_el.dataset.timestamp = story.timestamp.toString()
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
  og_link.classList.add("og_href")
  og_link.href = story.og_href
  og_link.addEventListener("click", open_link_handler)
  title_line.appendChild(og_link)

  let hostname = document.createElement("p")
  hostname.classList.add("hostname")
  hostname.innerText = " (" + link.hostname + ") "
  title_line.appendChild(hostname)

  let sources = document.createElement("div")
  sources.classList.add("sources")
  story.sources.forEach((x: StorySource) => {
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
  update_star(story.stared, story_el)

  let filter_btn = icon_button("filter", "filter_btn", "imgs/filter.svg")
  if (story.filter) {
    filter_btn.title = "filtered"
    story_el.classList.add("filtered")
    let dinp = document.createElement("input")
    dinp.classList.add("filter_input")
    dinp.type = "text"
    dinp.value = story.filter
    dinp.disabled = true
    dinp.style.cursor = "pointer"
    filter_btn.prepend(dinp)
    filter_btn.style.borderColor = "red"
  }
  story_el.appendChild(filter_btn)

  presenters.add_story_elem_buttons(story_el, story, inmain)

  if (inmain) {
    direct_events(story, story_el)
  } else {
    ipc_events(story, story_el, webtab)
  }

  return story_el
}

function update_storyel(event: CustomEvent, story_el: HTMLElement) {
  if (!event || !event.detail) {
    console.log("update_storyel fail", event, story_el)
    return
  }
  if (event.detail.value instanceof Story && event.detail.name) {
    switch (event.detail.name) {
      //TODO diff class before after, or completley redraw or fix on-change
      case "star":
      case "unstar":
        update_star(event.detail.value.stared, story_el)
        break
      case "mark_as_read":
      case "open_in_webview":
        update_read(event.detail.value, story_el)
        break
    }
  } else if (event.detail.path.length == 2) {
    switch (event.detail.path[1]) {
      case "read":
        update_read(event.detail.value, story_el)
        break
      case "sources":
        update_sources(event.detail.value, story_el)
        break
      case "stared":
        update_star(event.detail.value, story_el)
        break
      case "filter":
        break
    }
  }
}

function direct_events(story: Story, story_el: HTMLElement) {
  story_el.addEventListener("data_change", (e: CustomEvent) => {
    update_storyel(e, story_el)
  })

  let link = story_el.querySelector(".title")
  link.addEventListener("click", open_link_handler, false)

  let filter_btn = story_el.querySelector<HTMLElement>(".filter_btn")
  filter_btn.addEventListener("click", (x: MouseEvent) => {
    if (story_el.classList.contains("filtered")) {
      story_filters.show_filter(story.filter)
    } else {
      story_filters.show_filter_dialog(
        x,
        filter_btn,
        story,
        story_filters.add_filter
      )
    }
  })

  let read_btn = story_el.querySelector(".read_btn")
  read_btn.addEventListener("click", (x) => {
    toggle_read(story.href, story_list.resort_single)
  })

  //open story with middle click on "skip reading"
  read_btn.addEventListener("mousedown", (e: MouseEvent) => {
    if (e.button == 1) {
      return open_link_handler(e)
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

function ipc_events(story: Story, story_el: HTMLElement, webtab: WebTab) {
  story_el.addEventListener("data_change", (e: CustomEvent) => {
    update_storyel(e, story_el)
  })

  let link = story_el.querySelector(".title")
  link.addEventListener("click", open_link_handler, false)

  let filter_btn = story_el.querySelector<HTMLElement>(".filter_btn")
  filter_btn.onclick = (x) => {
    if (story_el.classList.contains("filtered")) {
      webtab.send_to_parent("show_filter", story.filter)
    } else {
      story_filters.show_filter_dialog(x, filter_btn, story, (x) => {
        webtab.send_to_parent("add_filter", x)
      })
    }
  }

  let read_btn = story_el.querySelector(".read_btn")
  read_btn.addEventListener("click", (x) => {
    webtab.send_to_parent("update_story", {
      href: story.href,
      path: "read",
      value: !story.read,
    })
  })

  //open story with middle click on "skip reading"
  read_btn.addEventListener("mousedown", (e: MouseEvent) => {
    if (e.button == 1) {
      return open_link_handler(e)
    }
  })

  let star_btn = story_el.querySelector(".star_btn")
  star_btn.addEventListener("click", (_) => {
    webtab.send_to_parent("update_story", {
      href: story.href,
      path: "stared",
      value: !story.stared,
    })
  })
}

function info_block(source_ob: StorySource) {
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
  comments_link.addEventListener("click", open_link_handler)
  comments_link.addEventListener("auxclick", open_link_handler)
  info.appendChild(comments_link)

  let time = document.createElement("div")
  time.innerText = story_parser.human_time(source_ob.timestamp)
  try {
    time.title = new Date(source_ob.timestamp).toISOString()
  } catch (e) {
    console.log("date parsing error", source_ob)
  }
  time.classList.add("time")
  info.appendChild(time)

  return info
}

function open_link_handler(e: any | MouseEvent) {
  e.preventDefault()
  e.stopPropagation()

  let href = this.href
  let target = e.target
  if (e.target.href) {
    href = e.target.href
  }
  if (e.button == 0) {
    web_control.open_in_tab(href)
  } else if (e.button == 1) {
    web_control.open_in_new_tab(href)
  }

  return false
}

function icon_button(title: string, classname: string, icon_src: string) {
  let btn = document.createElement("div")
  btn.classList.add("btn")
  btn.classList.add(classname)
  let icon = document.createElement("img")
  icon.src = icon_src
  btn.appendChild(icon)
  btn.title = title
  return btn
}

function add_read_button(story_el: HTMLElement, story: Story) {
  let read_btn = icon_button("", "read_btn", "")
  story_el.appendChild(read_btn)

  label_read(story_el)
}

function update_read(read: boolean, story_el: HTMLElement) {
  if (read) {
    story_el.classList.add("read")
  } else {
    story_el.classList.remove("read")
  }
  label_read(story_el)
}

function label_read(story_el: HTMLElement) {
  let btn = story_el.querySelector<HTMLElement>(".read_btn")

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

function toggle_read(href: string, callback: (story_el: HTMLElement) => any) {
  let story_el = document.querySelector<HTMLElement>(
    '.story[data-href="' + href + '"]'
  )
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

function add_star_button(story_el: HTMLElement, story: Story) {
  if (story.hasOwnProperty("stored_star")) {
    story_el.classList.add("stored_star")
  }

  let star_btn = icon_button("", "star_btn", "")
  story_el.appendChild(star_btn)
  label_star(story_el)
}

function label_star(story_el: HTMLElement) {
  let btn = story_el.querySelector<HTMLElement>(".star_btn")

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

function update_star(stared: boolean, story_el: HTMLElement) {
  if (stared) {
    story_el.classList.add("stared")
  } else {
    story_el.classList.remove("stared")
  }

  label_star(story_el)
}

function update_sources(sources: StorySource[], story_el: HTMLElement) {
  let sources_el = story_el.querySelector(".sources")
  sources_el.innerHTML = ""

  sources.forEach((x: StorySource) => {
    sources_el.append(info_block(x))
  })
}
