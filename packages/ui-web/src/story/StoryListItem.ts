import * as StoryFilterView from "./storyFilterView"
import { Story } from "@once/core"
// Registers the built-in outline button; imported for that side effect.
import "../presenters/registry"
import { applyStoryElements, refreshRowElements } from "./storyElements"
import { DataChangeEvent, resortSingle } from "./storyList"
import { URLRedirect } from "@once/core"
import { StoryHistory } from "./StoryHistory"
import { SettingsPanel } from "../settings/SettingsPanel"
import { getOnceClient } from "../client"
import { showConfirmDialog } from "../confirmDialog"
import { StoryMenuRequestEvent } from "../menu/storyContextMenu"
import { requestReading } from "../ReadingSession"
import { finishStoryExitTransition } from "./storyExitTransition"
import { open_story, openStoryUrl } from "./storyLinks"
import {
  buildFilterButton,
  buildPurgeButton,
  buildTitleLine,
  createIconButton
} from "./storyRowMarkup"
import { renderSubstories } from "./storyRowSubstories"
import { attachStorySwipe, SwipePreview } from "./swipe/gesture"

export class StoryListItem extends HTMLElement {
  static devToolsEnabled = false
  story: Story
  animated = false
  // assigned in story_html(), which the constructor always calls
  link!: HTMLAnchorElement
  title_line!: HTMLElement
  button_group!: HTMLElement
  read_btn!: HTMLElement
  filter_btn!: HTMLElement
  star_btn!: HTMLElement
  substories_el!: HTMLElement
  menu_btn!: HTMLElement
  private cancelReadAnimation?: () => void
  /** Set only on the swipe settings sample row; see SwipePreview. */
  swipePreview?: SwipePreview

  constructor(story: Story) {
    super()

    if (!(story instanceof Story)) {
      throw new TypeError("StoryListItem requires a Story instance")
    } else {
      this.story = story as Story
    }

    this.story_html()

  }

  story_html(add_listeners = true): void {
    this.classList.add("story")
    this.dataset.testid = "story"

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
    this.title_line = title_line
    this.link = buildTitleLine(this, title_line, redirected_url)

    this.substories_el = document.createElement("div")
    this.substories_el.classList.add("substories")
    renderSubstories(this)

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

    this.filter_btn = buildFilterButton(this)
    this.button_group.appendChild(this.filter_btn)

    if (StoryListItem.devToolsEnabled) {
      this.button_group.appendChild(buildPurgeButton(this))
    }

    this.add_menu_button()
    applyStoryElements(this)
    this.button_events()

    if (add_listeners) {
      attachStorySwipe(this)

      // Enter opens the row the keyboard cursor is on. Scoped to the row
      // itself rather than bound as a shortcut: Enter belongs to whatever has
      // focus, so a link or button inside the row keeps its own behaviour, and
      // the address bar and settings editors keep theirs.
      this.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" || event.target !== this) return
        event.preventDefault()
        this.openStory("_self")
      })

      this.addEventListener(
        "data_change",
        (event) => {
          this.update_story_el(event as DataChangeEvent)
        }
      )
    }
  }

  animate_read(): void {
    this.cancelReadAnimation?.()
    this.cancelReadAnimation = undefined

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
        this.cancelReadAnimation = finishStoryExitTransition(this, () => {
          this.cancelReadAnimation = undefined
          resort()
        })
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
      throw new TypeError("Story update requires a Story instance")
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
          renderSubstories(this)
          break
        case "stared":
          this.update_star()
          break
        case "stored_content":
          // The reader button shows whether an article is stored.
          refreshRowElements(this)
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
      this.showFilterAction(event)
    }

    this.read_btn.addEventListener("click", () => {
      this.toggleReadState()
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
      this.toggleBookmark()
    })
  }

  readActionLabel(): string {
    if (this.story.read_state === "unread") return "Skip reading"
    if (this.story.read_state === "read") return "Mark as unread"
    return "Unskip"
  }

  bookmarkActionLabel(): string {
    return this.story.stared ? "Remove bookmark" : "Bookmark"
  }

  filterActionLabel(): string {
    return this.story.filter ? "Edit filter" : "Filter source"
  }

  saveContentActionLabel(): string {
    return this.story.contentSource() === "page" ? "Update saved copy" : "Save for offline"
  }

  openStory(target: "_self" | "middle" | "blank"): void {
    this.read_btn.classList.add("user_interaction")
    if (target === "_self" && requestReading(this.story, "browser")) {
      void getOnceClient().persistStoryChange(
        this.story.href,
        "read_state",
        "read"
      )
      return
    }
    open_story(this.story.href, target)
  }

  openOriginal(): void {
    this.read_btn.classList.add("user_interaction")
    openStoryUrl(this.story.href, "_self", false)
  }

  openComments(): void {
    const commentsUrl = this.story.comment_url
    if (!commentsUrl) return
    this.read_btn.classList.add("user_interaction")
    if (!requestReading(this.story, "comments")) {
      openStoryUrl(commentsUrl, "_self", false)
    }
  }

  toggleReadState(): void {
    this.read_btn.classList.add("user_interaction")
    const oldState = this.story.read_state
    const newState = oldState === "unread" ? "skipped" : "unread"
    StoryHistory.instance?.story_change(this.story, newState, oldState)
    void getOnceClient().persistStoryChange(
      this.story.href,
      "read_state",
      newState
    )
  }

  toggleBookmark(): void {
    this.star_btn.classList.add("user_interaction")
    const value = !this.story.stared
    this.story.stared = value
    void getOnceClient().persistStoryChange(this.story.href, "stared", value)
  }

  showFilterAction(event?: MouseEvent): void {
    if (this.classList.contains("filtered")) {
      SettingsPanel.instance?.highlight_filter(this.story.filter, true)
      return
    }
    if (document.body.dataset.platform === "mobile") {
      StoryFilterView.show_mobile_filter_dialog(
        this.story,
        (filter) => getOnceClient().addFilter(filter)
      )
      return
    }
    StoryFilterView.show_filter_dialog(
      event ?? new MouseEvent("click"),
      this.filter_btn,
      this.story,
      (filter) => getOnceClient().addFilter(filter)
    )
  }

  async confirmPurge(): Promise<void> {
    const confirmed = await showConfirmDialog({
      message: "Delete this story from the local and synced remote database?",
      confirmLabel: "Purge",
      positionWithin:
        this.closest<HTMLElement>("#stories_panel") ?? undefined
    })
    if (!confirmed) return
    await getOnceClient().purgeStory(this.story.href)
    document
      .querySelectorAll<StoryListItem>(
        `.story[data-href="${CSS.escape(this.story.href)}"]`
      )
      .forEach((element) => element.remove())
  }

  /**
   * The ⋮ affordance. Hidden by default (Electron and the extensions use their
   * native context menus) and revealed by the touch platforms, which have no
   * such API.
   */
  add_menu_button(): void {
    this.menu_btn = createIconButton("story actions", "menu_btn")
    this.menu_btn.dataset.testid = "story-menu-button"
    this.menu_btn.textContent = "⋮"
    this.menu_btn.setAttribute("aria-haspopup", "menu")
    this.menu_btn.setAttribute("aria-label", "Story actions")
    // Claiming the press keeps the swipe gesture and the long-press detector
    // from arming, so the button opens the menu on TAP and nothing else fires.
    this.menu_btn.addEventListener("pointerdown", (event) => {
      event.stopPropagation()
    })
    this.menu_btn.addEventListener("click", (event) => {
      event.stopPropagation()
      this.requestMenu()
    })
    this.button_group.appendChild(this.menu_btn)
  }

  /** Anchors on the whole row by default so ⋮ and long-press agree. */
  requestMenu(anchor: HTMLElement = this): void {
    this.dispatchEvent(new StoryMenuRequestEvent(this, anchor))
  }

  add_read_button(): void {
    this.read_btn = createIconButton("", "read_btn")
    this.read_btn.dataset.testid = "story-read-state"
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

    this.star_btn = createIconButton("", "star_btn")
    this.star_btn.dataset.testid = "story-bookmark"
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
}

if (window.customElements && !window.customElements.get("story-item")) {
  window.customElements.define("story-item", StoryListItem)
}
