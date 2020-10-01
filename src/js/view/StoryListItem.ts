import * as story_parser from "../data/parser"
import * as StoryFilterView from "../view/StoryFilterView"
import { Story, SubStory } from "../data/Story"
import * as presenters from "../view/presenters"
import * as story_list from "../view/StoryList"
import { ipcRenderer } from "electron"
import * as URLFilters from "../data/URLFilters"
import { StoryMap } from "../data/StoryMap"

export class StoryListItem extends HTMLElement {
  story: Story
  animated: boolean
  read_btn: HTMLElement
  filter_btn: HTMLElement
  star_btn: HTMLElement
  substories_el: HTMLElement

  constructor(story: Story) {
    super()

    if (!(story instanceof Story)) {
      console.error("story not a story?", story)
      throw "only put a story in a story obj, no more magic"
    } else {
      this.story = story as Story
    }

    this.story_html()
  }

  story_html(): void {
    this.classList.add("story")

    const filtered_url = URLFilters.filter_url(this.story.href)

    this.dataset.title = this.story.title
    this.dataset.href = this.story.href
    this.dataset.filtered_url = filtered_url
    this.dataset.timestamp = this.story.timestamp.toString()
    this.dataset.type = "[" + this.story.type + "]"
    this.dataset.comment_url = this.story.comment_url

    const title_line = document.createElement("div")
    title_line.classList.add("title_line")

    const link = document.createElement("a")
    link.href = filtered_url
    link.classList.add("title")
    link.innerText = this.story.title
    title_line.appendChild(link)

    const og_link = document.createElement("a")
    og_link.innerText = " [OG] "
    og_link.classList.add("og_href")
    og_link.href = this.story.href
    title_line.appendChild(og_link)
    if (link.href == og_link.href) {
      //og_link.style.opacity = "0.4"
      og_link.style.display = "none"
    }

    const hostname = document.createElement("a")
    hostname.classList.add("hostname")
    hostname.innerText = " (" + og_link.hostname + ") "
    hostname.href = "search:domain:" + og_link.hostname
    hostname.target = "search"
    title_line.appendChild(hostname)

    this.substories_el = document.createElement("div")
    this.substories_el.classList.add("substories")
    this.update_substories()

    const data = document.createElement("div")
    document.createElement("data")
    data.classList.add("data")

    data.appendChild(title_line)
    data.appendChild(this.substories_el)

    this.appendChild(data)

    this.add_read_button()
    this.add_star_button()

    this.filter_btn = StoryListItem.icon_button(
      "filter",
      "filter_btn",
      "imgs/filter.svg"
    )
    if (this.story.filter) {
      this.filter_btn.title = "filtered"
      this.classList.add("filtered")
      const dinp = document.createElement("input")
      dinp.classList.add("filter_input")
      dinp.type = "text"
      dinp.value = this.story.filter
      dinp.disabled = true
      dinp.style.cursor = "pointer"
      this.filter_btn.prepend(dinp)
      this.filter_btn.style.borderColor = "red"
    }
    this.appendChild(this.filter_btn)

    presenters.add_story_elem_buttons(this, this.story)
    this.add_ipc_events()

    this.addEventListener(
      "data_change",
      (event: story_list.DataChangeEvent) => {
        this.update_story_el(event)
      }
    )
  }

  animate_read(): void {
    if (!this.parentElement) {
      //not attached to dom, no need to sort or animate anything, no on will see
      return
    }
    const anmim_class =
      this.story.read_state != "unread" ? "read_anim" : "unread_anim"
    const resort = story_list.resort_single(this)
    if (typeof resort == "function") {
      if (
        this.animated &&
        this.read_btn.classList.contains("user_interaction")
      ) {
        //consume user interaction
        this.read_btn.classList.remove("user_interaction")
        this.classList.add(anmim_class)
        this.addEventListener(
          "transitionend",
          () => {
            resort()
          },
          false
        )
      } else {
        resort()
      }
    }
  }

  update_story_el(event: story_list.DataChangeEvent): void {
    if (!event || !event.detail || !event.detail.story) {
      console.debug("update_story_el fail", event, this)
      return
    }
    if (!(event.detail.story instanceof Story)) {
      console.error("only like stories, got this:", event.detail.story)
      throw "nope, that is not a story ..."
    }

    this.animated = event.detail.animated
    document.body.setAttribute("animated", event.detail.animated.toString())
    this.story = event.detail.story

    console.debug("update_story_el", event.detail)

    if (event.detail.path.length == 2) {
      switch (event.detail.path[1]) {
        case "read_state":
          this.update_read()
          break
        case "substories":
          this.update_substories()
          break
        case "stared":
          this.update_star()
          break
        case "filter":
        default:
          this.update_complete_story_el()
          break
      }
    } else {
      this.update_complete_story_el()
    }
  }

  update_complete_story_el(): void {
    this.innerHTML = ""
    this.story_html()
  }

  add_ipc_events(): void {
    this.filter_btn.onclick = (event) => {
      if (this.classList.contains("filtered")) {
        ipcRenderer.send("forward_to_parent", "show_filter", this.story.filter)
      } else {
        StoryFilterView.show_filter_dialog(
          event,
          this.filter_btn,
          this.story,
          (filter) => {
            ipcRenderer.send("settings", "add_filter", filter)
          }
        )
      }
    }

    this.read_btn.addEventListener("click", () => {
      this.read_btn.classList.add("user_interaction")
      StoryMap.remote.persist_story_change(
        this.story.href,
        "read_state",
        this.story.read_state == "unread" ? "skipped" : "unread"
      )
    })

    //open story with middle click on "skip reading"
    this.read_btn.addEventListener("mouseup", (e: MouseEvent) => {
      if (e.button == 1) {
        window.open(this.story.href)
        e.stopPropagation()
        e.preventDefault()
        return true
      }
    })
    this.read_btn.addEventListener("mousedown", (e: MouseEvent) => {
      if (e.button == 1) {
        e.stopPropagation()
        e.preventDefault()
        return true
      }
    })

    this.star_btn.addEventListener("animationend", () => {
      this.star_btn.classList.remove("user_interaction")
    })
    this.star_btn.addEventListener("click", () => {
      this.star_btn.classList.add("user_interaction")
      const value = !this.story.stared
      this.story.stared = value
      console.log("click start value", this.story.stared, "setting", value)
      StoryMap.remote.persist_story_change(this.story.href, "stared", value)
    })
  }

  info_block(sub_story_ob: SubStory): HTMLElement {
    const info = document.createElement("div")
    info.classList.add("info")
    info.dataset.type = "[" + sub_story_ob.type + "]"
    const type = document.createElement("p")
    type.classList.add("type")
    type.innerText = sub_story_ob.type
    info.appendChild(type)

    //comments
    const comments_link = document.createElement("a")
    comments_link.classList.add("comment_url")
    comments_link.innerText = " [comments] "
    comments_link.href = sub_story_ob.comment_url
    info.appendChild(comments_link)

    const time = document.createElement("div")
    time.innerText = story_parser.human_time(sub_story_ob.timestamp)
    try {
      time.title = new Date(sub_story_ob.timestamp).toISOString()
    } catch (e) {
      console.log("date parsing error", sub_story_ob)
    }
    time.classList.add("time")
    info.appendChild(time)

    return info
  }

  static icon_button(
    title: string,
    classname: string,
    icon_src?: string
  ): HTMLElement {
    const btn = document.createElement("div")
    btn.classList.add("btn")
    btn.classList.add(classname)
    btn.setAttribute("draggable", "false")
    if (icon_src) {
      const icon = document.createElement("img")
      icon.setAttribute("draggable", "false")
      icon.src = icon_src
      btn.appendChild(icon)
    }
    btn.title = title
    return btn
  }

  add_read_button(): void {
    this.read_btn = StoryListItem.icon_button("", "read_btn")
    this.appendChild(this.read_btn)

    this.update_read()
  }

  update_read(): void {
    switch (this.story.read_state) {
      case "unread":
        this.classList.remove("read")
        this.classList.remove("skipped")
        break
      case "read":
        this.classList.add("read")
        break
      case "skipped":
        this.classList.add("read")
        this.classList.add("skipped")
        break
    }
    this.label_read()
    this.animate_read()
  }

  label_read(): void {
    switch (this.story.read_state) {
      case "unread":
        this.read_btn.title = "skip reading"
        break
      case "read":
        this.read_btn.title = "mark as unread"
        break
      case "skipped":
        this.read_btn.title = "unskip"
        break
    }
  }

  add_star_button(): void {
    if (Object.prototype.hasOwnProperty.call(this.story, "stored_star")) {
      this.classList.add("stored_star")
    }

    this.star_btn = StoryListItem.icon_button("", "star_btn")
    this.appendChild(this.star_btn)
    this.update_star()
  }

  label_star(): void {
    if (!this.star_btn) {
      return
    }

    if (this.classList.contains("stared")) {
      this.star_btn.title = "remove bookmark"
    } else {
      this.star_btn.title = "bookmark"
    }
  }

  update_star(): void {
    if (this.story.stared) {
      this.classList.add("stared")
    } else {
      this.classList.remove("stared")
    }

    this.label_star()
  }

  update_substories(): void {
    this.substories_el.innerHTML = ""

    const subs = [
      {
        type: this.story.type,
        comment_url: this.story.comment_url,
        timestamp: this.story.timestamp,
      },
      ...this.story.substories.filter((sub) => {
        return sub.comment_url != this.story.comment_url && sub.timestamp
      }),
    ]

    subs.forEach((x: SubStory) => {
      this.substories_el.append(this.info_block(x))
    })
  }
}

customElements.define("story-item", StoryListItem)
