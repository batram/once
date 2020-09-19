import * as story_parser from "../data/parser"
import { TabWrangler } from "../view/TabWrangler"
import { WebTab } from "../view/webtab"
import * as story_filters from "../data/filters"
import { Story, StorySource } from "../data/Story"
import { StoryMap } from "../data/StoryMap"
import * as presenters from "../view/presenters"
import * as story_list from "../view/StoryList"
import { ipcRenderer } from "electron"

export { story_html, info_block, icon_button }

function story_html(story: Story) {
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

  presenters.add_story_elem_buttons(story_el, story)
  ipc_events(story, story_el)
  story_el.addEventListener("data_change", (x: CustomEvent) => {
    update_story_el(x, story_el, story.to_obj())
  })
  return story_el
}

function animate_read(story_el: HTMLElement, new_read: boolean) {
  console.log("here I go animating again", story_el, new_read)
  let anmim_class = new_read ? "read_anim" : "unread_anim"

  let resort = story_list.resort_single(story_el) as Function
  if (typeof resort == "function") {
    if (document.body.classList.contains("animated")) {
      story_el.classList.add(anmim_class)
      story_el.addEventListener(
        "transitionend",
        (x) => {
          resort()
        },
        false
      )
    } else {
      resort()
    }
  }
}

function animate_star(story_el: HTMLElement, new_stared: boolean) {
  console.log("here I go animating again", story_el, new_stared)
  let anmim_class = new_stared ? "star_anim" : "unstar_anim"
  let icon_start = new_stared ? "imgs/star.svg" : "imgs/star_fill.svg"
  let icon_end = new_stared ? "imgs/star_fill.svg" : "imgs/star.svg"
  let star_btn_img = story_el.querySelector<HTMLImageElement>(".star_btn img")

  if (document.body.classList.contains("animated")) {
    star_btn_img.src = icon_start
    story_el.classList.add(anmim_class)
    story_el.addEventListener(
      "animationend",
      () => {
        setTimeout(() => {
          story_el.classList.remove(anmim_class)
          star_btn_img.src = icon_end
        }, 1)
      },
      false
    )
  }
}

function update_story_el(
  event: CustomEvent,
  story_el: HTMLElement,
  old_story: { read: boolean; stared: boolean }
) {
  if (!event || !event.detail || !event.detail.story) {
    console.debug("update_story_el fail", event, story_el)
    return
  }

  if (event.detail.path.length == 2) {
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
      default:
        update_complete_story_el(story_el, event.detail.story)
        break
    }
  }
}

function update_complete_story_el(story_el: HTMLElement, story: Story) {
  let new_story_el = story_html(story)
  story_el.replaceWith(new_story_el)
}

function ipc_events(story: Story, story_el: HTMLElement) {
  let filter_btn = story_el.querySelector<HTMLElement>(".filter_btn")
  filter_btn.onclick = (x) => {
    if (story_el.classList.contains("filtered")) {
      ipcRenderer.send("tab_intercom", "show_filter", story.filter)
    } else {
      story_filters.show_filter_dialog(x, filter_btn, story, (x) => {
        ipcRenderer.send("tab_intercom", "add_filter", x)
      })
    }
  }
  /*  let read_btn = story_el.querySelector(".read_btn")
  read_btn.addEventListener("click", (x) => {
    toggle_read(story.href, story_list.resort_single)
  })

*/
  let read_btn = story_el.querySelector(".read_btn")
  read_btn.addEventListener("click", (x) => {
    ipcRenderer.send("tab_intercom", "persist_story_change", {
      href: story.href,
      path: "read",
      value: !story.read,
    })
  })

  //open story with middle click on "skip reading"
  read_btn.addEventListener("mouseup", (e: MouseEvent) => {
    if (e.button == 1) {
      window.open(story.href)
      e.stopPropagation()
      e.preventDefault()
      return true
    }
  })
  read_btn.addEventListener("mousedown", (e: MouseEvent) => {
    if (e.button == 1) {
      e.stopPropagation()
      e.preventDefault()
      return true
    }
  })

  let star_btn = story_el.querySelector(".star_btn")
  star_btn.addEventListener("click", (_) => {
    let value = !story.stared
    story.stared = value
    console.log("click start value", story.stared, "setting", value)
    ipcRenderer.send("tab_intercom", "persist_story_change", {
      href: story.href,
      path: "stared",
      value: value,
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

function icon_button(title: string, classname: string, icon_src: string) {
  let btn = document.createElement("div")
  btn.classList.add("btn")
  btn.classList.add(classname)
  btn.setAttribute("draggable", "false")
  let icon = document.createElement("img")
  icon.setAttribute("draggable", "false")
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
  animate_read(story_el, read)
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
  let classes_before = story_el.classList.value.toString()

  if (stared) {
    story_el.classList.add("stared")
  } else {
    story_el.classList.remove("stared")
  }
  let classes_after = story_el.classList.value.toString()

  label_star(story_el)

  if (classes_after != classes_before) {
    animate_star(story_el, stared)
  }
}

function update_sources(sources: StorySource[], story_el: HTMLElement) {
  let sources_el = story_el.querySelector(".sources")
  sources_el.innerHTML = ""

  sources.forEach((x: StorySource) => {
    sources_el.append(info_block(x))
  })
}
