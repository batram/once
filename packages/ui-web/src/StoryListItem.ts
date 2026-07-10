import { humanTime } from "@once/core"
import * as StoryFilterView from "./StoryFilterView"
import { Story, SubStory } from "@once/core"
import * as presenters from "./presenters_frontend"
import { DataChangeEvent, resortSingle } from "./StoryList"
import { URLRedirect } from "@once/core"
import { StoryHistory } from "./StoryHistory"
import { SettingsPanel } from "./SettingsPanel"
import { getOnceClient } from "./client"
import * as Search from "./search"

export class StoryListItem extends HTMLElement {
  story: Story
  animated: boolean
  link: HTMLAnchorElement
  button_group: HTMLElement
  read_btn: HTMLElement
  filter_btn: HTMLElement
  star_btn: HTMLElement
  substories_el: HTMLElement
  sw_left: HTMLElement
  sw_right: HTMLElement

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

  story_html(add_listeners = true): void {
    this.classList.add("story")

    const redirected_url = URLRedirect.redirect_url(this.story.href)

    this.dataset.title = this.story.title
    this.dataset.href = this.story.href
    this.dataset.redirected_url = redirected_url
    this.dataset.timestamp = this.story.timestamp
      ? this.story.timestamp.toString()
      : ""
    this.dataset.type = "[" + this.story.type + "]"
    this.dataset.comment_url = this.story.comment_url

    const title_line = document.createElement("div")
    title_line.classList.add("title_line")

    this.link = document.createElement("a")
    this.link.href = redirected_url
    this.link.classList.add("title")
    this.link.innerText = this.story.title
    bindLinkBehavior(this.link, {
      onClick: () => {
        this.read_btn.classList.add("user_interaction")
        open_story(this.story.href, "_self")
      },
      onMiddleClick: () => {
        this.read_btn.classList.add("user_interaction")
        open_story(this.story.href, "middle")
      }
    })

    title_line.appendChild(this.link)

    const og_link = document.createElement("a")
    og_link.innerText = " [OG] "
    og_link.classList.add("og_href")
    og_link.href = this.story.href
    bindLinkBehavior(og_link, {
      onClick: () => {
        this.read_btn.classList.add("user_interaction")
        openStoryUrl(this.story.href, "_self", false)
      },
      onMiddleClick: () => {
        this.read_btn.classList.add("user_interaction")
        openStoryUrl(this.story.href, "middle", false)
      }
    })
    title_line.appendChild(og_link)
    if (this.link.href == og_link.href) {
      //og_link.style.opacity = "0.4"
      og_link.style.display = "none"
    }

    const hostname = document.createElement("a")
    hostname.classList.add("hostname")
    hostname.innerText = " (" + og_link.hostname + ") "
    hostname.href = "search:domain:" + og_link.hostname
    hostname.target = "search"
    bindLinkBehavior(hostname, {
      onClick: () => {
        Search.searchStories("domain:" + og_link.hostname)
      }
    })
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

    this.button_group = document.createElement("div")
    this.button_group.classList.add("button_group")
    this.appendChild(this.button_group)

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
      dinp.style.cursor = "pointer"
      dinp.readOnly = true
      dinp.addEventListener("click", (event) => {
        event.stopPropagation()
        if (SettingsPanel.instance) {
          SettingsPanel.instance.highlight_filter(this.story.filter, true)
        }
      })
      this.filter_btn.prepend(dinp)
      this.filter_btn.style.borderColor = "red"
    }
    this.button_group.appendChild(this.filter_btn)

    presenters.add_story_elem_buttons(this, this.story)
    this.button_events()

    if (add_listeners) {
      this.swipeable()

      this.addEventListener(
        "data_change",
        (event: DataChangeEvent) => {
          this.update_story_el(event)
        }
      )
    }
  }

  animate_read(): void {
    if (!this.parentElement) {
      //not attached to dom, no need to sort or animate anything, no on will see
      return
    }
    const anmim_class = this.story.read_state + "_anim"
    const resort = resortSingle(this)
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

  update_story_el(event: DataChangeEvent): void {
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
    this.story_html(false)
  }

  button_events(): void {
    this.filter_btn.onclick = (event) => {
      if (this.classList.contains("filtered")) {
        if (SettingsPanel.instance) {
          SettingsPanel.instance.highlight_filter(this.story.filter, true)
        }
      } else {
        StoryFilterView.show_filter_dialog(
          event,
          this.filter_btn,
          this.story,
          (filter) => {
            getOnceClient().addFilter(filter)
          }
        )
      }
    }

    this.read_btn.addEventListener("click", () => {
      this.read_btn.classList.add("user_interaction")
      const old_state = this.story.read_state
      const new_state = this.story.read_state == "unread" ? "skipped" : "unread"
      if (StoryHistory.instance) {
        StoryHistory.instance.story_change(this.story, new_state, old_state)
      }
      getOnceClient().persistStoryChange(
        this.story.href,
        "read_state",
        new_state
      )
    })

    //open story with middle click on "skip reading"
    this.read_btn.addEventListener("mouseup", (e: MouseEvent) => {
      if (e.button == 1) {
        open_story(this.story.href, "blank")

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
      console.debug("click start value", this.story.stared, "setting", value)
      getOnceClient().persistStoryChange(this.story.href, "stared", value)
    })
  }

  swipeable = (): void => {
    let start_offset = -1
    const threshold = 0.1

    const add_background_element = () => {
      this.style.display = "inline-flex"

      if (!this.querySelector(".bb_slide")) {
        const bb_slide_el = document.createElement("div")
        bb_slide_el.style.height = this.clientHeight + "px"
        bb_slide_el.style.marginBottom = -this.clientHeight + "px"
        bb_slide_el.style.lineHeight = this.clientHeight + "px"
        bb_slide_el.classList.add("bb_slide")

        const bb_slide_left = document.createElement("div")
        bb_slide_left.innerText = "read"
        bb_slide_left.classList.add("swipe_left")
        bb_slide_left.style.backgroundImage =
          "linear-gradient(45deg, rgba(0, 128, 0, 0.5), transparent 50%)"
        bb_slide_el.append(bb_slide_left)
        this.sw_left = bb_slide_left

        const bb_slide_right = document.createElement("div")
        bb_slide_right.innerText = "skip"
        bb_slide_right.classList.add("swipe_right")
        bb_slide_right.style.backgroundImage =
          "linear-gradient(45deg, transparent 50%, rgba(200, 0, 0, 0.5))"
        bb_slide_el.append(bb_slide_right)
        this.sw_right = bb_slide_right

        this.before(bb_slide_el)
      }
    }

    const mouse_swipe = (event: MouseEvent) => {
      if (start_offset == -1) {
        start_offset = event.pageX
        add_background_element()
      }
      swipe(event.pageX)
    }

    const touch_swipe = (event: TouchEvent) => {
      const one_touch = event.touches[0]
      if (start_offset == -1) {
        start_offset = one_touch.clientX
        add_background_element()
      }
      swipe(one_touch.clientX)
    }
    
    const swipe = (x: number) => {
      //check that slide_bb is infront of our story element
      if (!this.previousElementSibling.classList.contains("bb_slide")) {
        //find and place in front of story element
        const bb_slide_el = document.querySelector(".bb_slide")
        if (bb_slide_el) {
          this.before(bb_slide_el)
        }
      }
      this.style.transition = "none"
      const shift = x - start_offset
      const shift_percent = Math.abs(shift) / this.clientWidth


      if (this.sw_left && this.sw_right) {
        if (shift_percent > threshold) {
          this.sw_left.style.fontWeight = "bold"
          this.sw_right.style.fontWeight = "bold"
        } else {
          this.sw_left.style.fontWeight = ""
          this.sw_right.style.fontWeight = ""
        }
      }

      this.style.transform = `translateX(${shift}px)`
    }

    this.addEventListener("touchmove", () => {
      document.addEventListener("touchmove", touch_swipe)
      document.addEventListener("touchend", end_swipe)
      document.addEventListener("pointerup", end_swipe)
      this.parentElement.addEventListener("scroll", end_swipe)
    })

    this.addEventListener("pointerdown", (e) => {
      if (
        e.button != 0 ||
        (e.target as HTMLElement).getAttribute("draggable") == "false"
      ) {
        e.stopPropagation()
        return
      }
      this.parentElement.style.width = this.parentElement.offsetWidth + "px"
      e.preventDefault()
      document.body.style.cursor = "w-resize"
      document.addEventListener("pointermove", mouse_swipe)
      document.addEventListener("touchmove", touch_swipe)
      document.addEventListener("touchend", end_swipe)
      document.addEventListener("pointerup", end_swipe)
      this.parentElement.addEventListener("scroll", end_swipe)
    })

    const end_swipe = (e: Event) => {
      e.preventDefault()
      e.stopPropagation()
      this.style.display = ""
      if (this.parentElement) {
        this.parentElement.style.width = ""
      }
      
      // Extract shift value from transform
      const transformValue = this.style.transform
      let shift = 0
      if (transformValue && transformValue.includes("translateX")) {
        const match = transformValue.match(/translateX\((-?\d+)px\)/)
        if (match) {
          shift = parseInt(match[1])
        }
      }
      
      if (Math.abs(shift) / this.clientWidth > threshold) {
        if (shift < 0) {
          this.read_btn.classList.add("user_interaction")
          StoryHistory.instance.story_change(
            this.story,
            "skipped",
            this.story.read_state
          )
          getOnceClient().persistStoryChange(
            this.story.href,
            "read_state",
            "skipped"
          )
        } else {
          open_story(this.story.href, "_self")
        }
      }

      document.querySelectorAll(".bb_slide").forEach((el: HTMLElement) => {
        el.outerHTML = ""
      })

      start_offset = -1
      this.style.transition = ""
      this.style.transform = ""
      document.body.style.cursor = ""
      document.removeEventListener("touchmove", touch_swipe)
      document.removeEventListener("pointermove", mouse_swipe)
      document.removeEventListener("touchend", end_swipe)
      document.removeEventListener("pointerup", end_swipe)

      return false
    }
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
    comments_link.href = sub_story_ob.comment_url || this.story.href
    info.appendChild(comments_link)

    const commentsUrl = sub_story_ob.comment_url || this.story.href
    bindLinkBehavior(comments_link, {
      onClick: () => {
        this.read_btn.classList.add("user_interaction")
        openStoryUrl(commentsUrl, "_self", false)
      },
      onMiddleClick: () => {
        this.read_btn.classList.add("user_interaction")
        openStoryUrl(commentsUrl, "middle", false)
      }
    })

    const time = document.createElement("div")
    time.innerText = humanTime(sub_story_ob.timestamp)
    try {
      time.title = new Date(
        parseInt(sub_story_ob.timestamp.toString())
      ).toISOString()
    } catch (e) {
      console.log("date parsing error", sub_story_ob)
    }
    time.classList.add("time")
    info.appendChild(time)

    const tags_container = document.createElement("div")
    tags_container.classList.add("tags_container")
    if (sub_story_ob.tags) {
      sub_story_ob.tags.forEach((tag) => {
        const tag_el = document.createElement("a")
        tag_el.classList.add("tag")
        tag_el.classList.add("tag_" + tag.class)
        tag_el.innerText = tag.text

        if (tag.href) {
          tag_el.href = tag.href
          bindLinkBehavior(tag_el, {
            onClick: () => {
              getOnceClient().openUrl(tag.href!, "_self")
            },
            onMiddleClick: () => {
              getOnceClient().openUrl(tag.href!, "middle")
            }
          })
        }

        if (tag.icon) {
          tag_el.style.background = `url(${tag.icon}) no-repeat`
          tag_el.style.backgroundSize = "13px"
          tag_el.style.backgroundPosition = "left top"
          tag_el.style.paddingLeft = "17px"
        }

        tags_container.append(tag_el)
      })
    }
    info.appendChild(tags_container)

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
    this.button_group.appendChild(this.read_btn)

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
    this.button_group.appendChild(this.star_btn)
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
        tags: this.story.tags
      },
      ...this.story.substories.filter((sub) => {
        return sub.comment_url != this.story.comment_url && sub.timestamp
      })
    ]

    subs.forEach((x: SubStory) => {
      this.substories_el.append(this.info_block(x))
    })
  }
}

if (window.customElements && !window.customElements.get("story-item")) {
  window.customElements.define("story-item", StoryListItem)
}

function bindLinkBehavior(
  el: HTMLAnchorElement,
  options: {
    onClick: () => void
    onMiddleClick?: () => void
  }
) {
  el.addEventListener("click", (e: MouseEvent) => {
    if (e.button === 0) {
      e.preventDefault()
      e.stopPropagation()
      options.onClick()
    }
  })

  if (options.onMiddleClick) {
    el.addEventListener("mousedown", (e: MouseEvent) => {
      if (e.button === 1) {
        e.preventDefault()
        e.stopPropagation()
      }
    })

    el.addEventListener("mouseup", (e: MouseEvent) => {
      if (e.button === 1) {
        e.preventDefault()
        e.stopPropagation()
        options.onMiddleClick!()
      }
    })

    el.addEventListener("auxclick", (e: MouseEvent) => {
      if (e.button === 1) {
        e.preventDefault()
        e.stopPropagation()
      }
    })
  }
}

function openStoryUrl(href: string, target: string, useRedirect = true) {
  const url = useRedirect ? URLRedirect.redirect_url(href) : href
  getOnceClient().persistStoryChange(href, "read_state", "read")
  getOnceClient().openUrl(url, target)
}

function open_story(href: string, target: string) {
  openStoryUrl(href, target, true)
}
