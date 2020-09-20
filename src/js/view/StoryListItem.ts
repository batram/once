import * as story_parser from "../data/parser"
import * as story_filters from "../data/filters"
import { Story, StorySource } from "../data/Story"
import * as presenters from "../view/presenters"
import * as story_list from "../view/StoryList"
import { ipcRenderer } from "electron"
import { DataChangeEvent } from "../data/StoryMap"

export class StoryListItem extends HTMLElement {
  story: Story
  story_el: HTMLElement
  animated: boolean

  constructor(story: Story | EventListenerObject) {
    super()

    if (!(this.story instanceof Story)) {
      this.story = Story.from_obj(story)
    } else {
      this.story = story as Story
    }

    this.story_html()
  }

  story_html() {
    this.classList.add("story")
    this.dataset.title = this.story.title
    this.dataset.href = this.story.href
    this.dataset.timestamp = this.story.timestamp.toString()
    this.dataset.type = "[" + this.story.type + "]"
    this.dataset.comment_url = this.story.comment_url

    let title_line = document.createElement("div")
    title_line.classList.add("title_line")

    let link = document.createElement("a")
    link.href = this.story.href
    link.classList.add("title")
    link.innerText = this.story.title
    title_line.appendChild(link)

    let og_link = document.createElement("a")
    og_link.innerText = " [OG] "
    og_link.classList.add("og_href")
    og_link.href = this.story.og_href
    title_line.appendChild(og_link)

    let hostname = document.createElement("p")
    hostname.classList.add("hostname")
    hostname.innerText = " (" + link.hostname + ") "
    title_line.appendChild(hostname)

    let sources = document.createElement("div")
    sources.classList.add("sources")
    this.story.sources.forEach((x: StorySource) => {
      sources.append(this.info_block(x))
    })

    let data = document.createElement("div")
    document.createElement("data")
    data.classList.add("data")

    data.appendChild(title_line)
    data.appendChild(sources)

    this.appendChild(data)

    this.add_read_button()
    this.add_star_button()

    this.update_read(this.story.read)
    this.update_star(this.story.stared)

    let filter_btn = StoryListItem.icon_button(
      "filter",
      "filter_btn",
      "imgs/filter.svg"
    )
    if (this.story.filter) {
      filter_btn.title = "filtered"
      this.classList.add("filtered")
      let dinp = document.createElement("input")
      dinp.classList.add("filter_input")
      dinp.type = "text"
      dinp.value = this.story.filter
      dinp.disabled = true
      dinp.style.cursor = "pointer"
      filter_btn.prepend(dinp)
      filter_btn.style.borderColor = "red"
    }
    this.appendChild(filter_btn)

    presenters.add_story_elem_buttons(this, this.story)
    this.add_ipc_events()

    this.addEventListener("data_change", (event: DataChangeEvent) => {
      this.update_story_el(event)
    })

    //mark user-interaction to play animation when on-change triggers after persist
    this.addEventListener("mouseup", (event) => {
      this.classList.add("user_interaction")
    })
  }

  animate_read(new_read: boolean) {
    console.log("here I go animating again", this, new_read)
    let anmim_class = new_read ? "read_anim" : "unread_anim"

    let resort = story_list.resort_single(this) as Function
    if (typeof resort == "function") {
      if (this.animated && this.classList.contains("user_interaction")) {
        //consume user interaction
        this.classList.remove("user_interaction")
        this.classList.add(anmim_class)
        this.addEventListener(
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

  animate_star(new_stared: boolean) {
    console.log("here I go animating again", this, new_stared)
    let anmim_class = new_stared ? "star_anim" : "unstar_anim"
    let icon_start = new_stared ? "imgs/star.svg" : "imgs/star_fill.svg"
    let icon_end = new_stared ? "imgs/star_fill.svg" : "imgs/star.svg"
    let star_btn_img = this.querySelector<HTMLImageElement>(".star_btn img")

    if (this.animated && this.classList.contains("user_interaction")) {
      //consume user interaction
      this.classList.remove("user_interaction")
      star_btn_img.src = icon_start
      this.classList.add(anmim_class)
      this.addEventListener(
        "animationend",
        () => {
          setTimeout(() => {
            this.classList.remove(anmim_class)
            star_btn_img.src = icon_end
          }, 1)
        },
        false
      )
    }
  }

  update_story_el(event: DataChangeEvent) {
    if (!event || !event.detail || !event.detail.story) {
      console.debug("update_story_el fail", event, this)
      return
    }

    this.animated = event.detail.animated
    document.body.setAttribute("animated", event.detail.animated.toString())

    if (event.detail.path.length == 2) {
      switch (event.detail.path[1]) {
        case "read":
          this.update_read(event.detail.value)
          break
        case "sources":
          this.update_sources(event.detail.value)
          break
        case "stared":
          this.update_star(event.detail.value)
          break
        case "filter":
        default:
          this.update_complete_story_el(event.detail.story)
          break
      }
    }

    this.story = event.detail.story
  }

  update_complete_story_el(story: Story) {
    let old_story_el = this
    this.story_html()
    old_story_el.replaceWith(this)
  }

  add_ipc_events() {
    let filter_btn = this.querySelector<HTMLElement>(".filter_btn")
    filter_btn.onclick = (x) => {
      if (this.classList.contains("filtered")) {
        ipcRenderer.send("tab_intercom", "show_filter", this.story.filter)
      } else {
        story_filters.show_filter_dialog(x, filter_btn, this.story, (x) => {
          ipcRenderer.send("tab_intercom", "add_filter", x)
        })
      }
    }

    let read_btn = this.querySelector(".read_btn")
    read_btn.addEventListener("click", (x) => {
      ipcRenderer.send("tab_intercom", "persist_story_change", {
        href: this.story.href,
        path: "read",
        value: !this.story.read,
      })
    })

    //open story with middle click on "skip reading"
    read_btn.addEventListener("mouseup", (e: MouseEvent) => {
      if (e.button == 1) {
        window.open(this.story.href)
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

    let star_btn = this.querySelector(".star_btn")
    star_btn.addEventListener("click", (_) => {
      let value = !this.story.stared
      this.story.stared = value
      console.log("click start value", this.story.stared, "setting", value)
      ipcRenderer.send("tab_intercom", "persist_story_change", {
        href: this.story.href,
        path: "stared",
        value: value,
      })
    })
  }

  info_block(source_ob: StorySource) {
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

  static icon_button(title: string, classname: string, icon_src: string) {
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

  add_read_button() {
    let read_btn = StoryListItem.icon_button("", "read_btn", "")
    this.appendChild(read_btn)

    this.label_read()
  }

  update_read(read: boolean) {
    if (read) {
      this.classList.add("read")
    } else {
      this.classList.remove("read")
    }
    this.label_read()
    this.animate_read(read)
  }

  label_read() {
    let btn = this.querySelector<HTMLElement>(".read_btn")

    if (!btn) {
      return
    }
    let icon = btn.querySelector("img")

    if (!this.classList.contains("read")) {
      btn.title = "skip reading"
      icon.src = "imgs/read.svg"
    } else {
      btn.title = "mark as unread"
      icon.src = "imgs/unread.svg"
    }
  }

  add_star_button() {
    if (this.story.hasOwnProperty("stored_star")) {
      this.classList.add("stored_star")
    }

    let star_btn = StoryListItem.icon_button("", "star_btn", "")
    this.appendChild(star_btn)
    this.label_star()
  }

  label_star() {
    let btn = this.querySelector<HTMLElement>(".star_btn")

    if (!btn) {
      return
    }
    let icon = btn.querySelector("img")

    if (this.classList.contains("stared")) {
      btn.title = "remove bookmark"
      icon.src = "imgs/star_fill.svg"
    } else {
      btn.title = "bookmark"
      icon.src = "imgs/star.svg"
    }
  }

  update_star(stared: boolean) {
    let classes_before = this.classList.value.toString()

    if (stared) {
      this.classList.add("stared")
    } else {
      this.classList.remove("stared")
    }
    let classes_after = this.classList.value.toString()

    this.label_star()

    if (classes_after != classes_before) {
      this.animate_star(stared)
    }
  }

  update_sources(sources: StorySource[]) {
    let sources_el = this.querySelector(".sources")
    sources_el.innerHTML = ""

    sources.forEach((x: StorySource) => {
      sources_el.append(this.info_block(x))
    })
  }
}

customElements.define("story-item", StoryListItem)
