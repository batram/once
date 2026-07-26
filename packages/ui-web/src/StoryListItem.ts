import {
  DEFAULT_SWIPE_SETTINGS,
  SWIPE_ACTION_LABELS,
  SwipeActionId,
  SwipeSettings
} from "@once/app"
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
import { showConfirmDialog } from "./ConfirmDialog"
import {
  getTouchGestureAxis,
  getTouchGestureStart
} from "./TouchGestureLock"
import {
  executeStoryMenuAction,
  StoryMenuRequestEvent
} from "./StoryContextMenu"
import { requestReading } from "./ReadingSession"
import { finishStoryExitTransition } from "./StoryExitTransition"

/**
 * Two-stage detented swipe.
 *
 * The row rests on a plateau instead of tracking the finger, so the committed
 * action is unambiguous at the moment of release — classic mail-app behaviour.
 * Distances and actions are user-configurable; see swipeSettings.ts.
 */
/** Snapping between plateaus, and springing back after a release. */
const SWIPE_SNAP_TRANSITION = "transform 90ms ease-out"
const SWIPE_RELEASE_TRANSITION = "transform 200ms cubic-bezier(.2, .8, .2, 1)"

export type SwipeStage = 0 | 1 | 2

/** Where a drag rests and what it commits, for one set of settings. */
export interface SwipeGeometry {
  stage(offset: number): SwipeStage
  plateau(offset: number): number
  actionFor(offset: number): SwipeActionId
  /**
   * What an engaged stage commits, for a drag in `direction` (-1 left,
   * 1 right). Committing works off the stage the drag reached, never off the
   * plateau it is resting on: the two only agree while every stage's resting
   * offset happens to sit past its own threshold.
   */
  actionAt(stage: SwipeStage, direction: number): SwipeActionId
}

/**
 * The geometry reads its settings through `read` on every call, so a caller
 * can drive a row from settings that are still being edited (the swipe
 * settings preview row) without touching the live configuration.
 */
export function createSwipeGeometry(
  read: () => SwipeSettings
): SwipeGeometry {
  const geometry: SwipeGeometry = {
    stage(offset) {
      const distance = Math.abs(offset)
      const settings = read()
      const [first, second] = settings.stages
      if (distance < first.threshold) return 0
      if (!settings.twoStage || distance < second.threshold) return 1
      return 2
    },

    plateau(offset) {
      const stage = geometry.stage(offset)
      if (stage === 0) return 0
      return Math.sign(offset) * read().stages[stage === 1 ? 0 : 1].offset
    },

    actionFor(offset) {
      return geometry.actionAt(geometry.stage(offset), Math.sign(offset))
    },

    actionAt(stage, direction) {
      if (stage === 0) return "none"
      const settings = read()
      const actions = direction < 0 ? settings.left : settings.right
      return actions[stage === 1 ? 0 : 1]
    }
  }
  return geometry
}

/**
 * Live swipe configuration, shared by every row. Rows are created and
 * destroyed constantly, so the settings live here rather than per instance;
 * mountOnceUi seeds it and keeps it current.
 */
export const SwipeConfig: SwipeGeometry & { current: SwipeSettings } = {
  current: DEFAULT_SWIPE_SETTINGS,
  ...createSwipeGeometry(() => SwipeConfig.current)
}

/**
 * Turns a row into a sample the user can drag without consequences: the
 * gesture uses `geometry` instead of the live settings, and a release reports
 * the action it would have run instead of running it.
 */
export interface SwipePreview {
  geometry: SwipeGeometry
  /** Element the touch axis lock is keyed to, in place of #stories. */
  scroller: HTMLElement
  onAction(action: SwipeActionId, stage: SwipeStage): void
}

export class StoryListItem extends HTMLElement {
  static devToolsEnabled = false
  story: Story
  animated = false
  // assigned in story_html(), which the constructor always calls
  link!: HTMLAnchorElement
  button_group!: HTMLElement
  read_btn!: HTMLElement
  filter_btn!: HTMLElement
  star_btn!: HTMLElement
  substories_el!: HTMLElement
  sw_left!: HTMLElement
  sw_right!: HTMLElement
  bb_slide?: HTMLElement
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

    this.link = document.createElement("a")
    this.link.href = redirected_url
    this.link.classList.add("title")
    this.link.dataset.testid = "story-title"
    this.link.innerText = this.story.title
    bindLinkBehavior(this.link, {
      onClick: () => {
        this.read_btn.classList.add("user_interaction")
        if (!requestReading(this.story, "browser")) {
          open_story(this.story.href, "_self")
        } else {
          void getOnceClient().persistStoryChange(
            this.story.href,
            "read_state",
            "read"
          )
        }
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
    og_link.dataset.testid = "story-external"
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

    if (StoryListItem.devToolsEnabled) {
      const purgeButton = StoryListItem.icon_button("purge story", "purge_btn")
      purgeButton.dataset.testid = "purge-story"
      purgeButton.textContent = "×"
      purgeButton.addEventListener("click", () => {
        void this.confirmPurge()
      })
      this.button_group.appendChild(purgeButton)
    }

    presenters.add_story_elem_buttons(this, this.story)
    this.add_menu_button()
    this.button_events()

    if (add_listeners) {
      this.swipeable()

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

  swipeable = (): void => {
    let start_offset = -1
    // where the row currently rests, always 0 or one of the stage offsets
    let plateau = 0
    // how far the pointer has travelled from where the press started, and the
    // stage that distance engages. The commit reads these, not the plateau:
    // thresholds and resting offsets are configured independently, so a stage
    // can rest short of its own threshold without becoming uncommittable.
    let drag_offset = 0
    let stage: SwipeStage = 0
    // Read per gesture rather than captured: a preview row is configured
    // after story_html() has already installed the handlers.
    const geometry = (): SwipeGeometry => this.swipePreview?.geometry ?? SwipeConfig

    // The reveal is absolutely positioned over the row's own box, inside the
    // scroll container. It must not participate in layout: an in-flow sibling
    // (even one cancelled out with a negative margin) reflows the list, and
    // the rows above it visibly jump the moment a drag begins.
    const add_background_element = () => {
      if (!this.bb_slide?.isConnected) {
        const bb_slide_el = document.createElement("div")
        bb_slide_el.classList.add("bb_slide")

        const bb_slide_left = document.createElement("div")
        bb_slide_left.classList.add("swipe_left")
        bb_slide_el.append(bb_slide_left)
        this.sw_left = bb_slide_left

        const bb_slide_right = document.createElement("div")
        bb_slide_right.classList.add("swipe_right")
        bb_slide_el.append(bb_slide_right)
        this.sw_right = bb_slide_right

        this.bb_slide = bb_slide_el
        // Before the row in DOM order so the row paints over it. Both sit in
        // the positioned layer — the row because of its transform.
        this.before(bb_slide_el)
      }
      position_background()
      update_reveal(drag_offset)
    }

    // offsetTop/offsetHeight are layout positions, unaffected by the row's own
    // transform, so the reveal stays put while the row slides across it.
    const position_background = () => {
      if (!this.bb_slide) return
      this.bb_slide.style.top = this.offsetTop + "px"
      this.bb_slide.style.height = this.offsetHeight + "px"
      this.bb_slide.style.lineHeight = this.offsetHeight + "px"
    }

    // The revealed side names the action in words and recolors per stage, so
    // the escalation from stage 1 to stage 2 is legible mid-gesture.
    const update_reveal = (offset: number) => {
      if (!this.sw_left || !this.sw_right) return
      const stage = geometry().stage(offset)
      const revealed = offset > 0 ? this.sw_left : this.sw_right
      const hidden = offset > 0 ? this.sw_right : this.sw_left

      hidden.innerText = ""
      hidden.dataset.stage = "0"
      hidden.dataset.action = "none"

      const action = geometry().actionFor(offset)
      revealed.innerText = stage === 0 ? "" : SWIPE_ACTION_LABELS[action]
      revealed.dataset.stage = String(stage)
      // CSS picks the reveal colour off the action, so a reconfigured swipe
      // keeps its colour meaning instead of colouring by stage number.
      revealed.dataset.action = stage === 0 ? "none" : action
    }

    const mouse_swipe = (event: MouseEvent) => {
      if (!this.bb_slide) {
        add_background_element()
      }
      swipe(event.pageX)
    }

    const touch_swipe = (event: TouchEvent) => {
      const scroller =
        this.swipePreview?.scroller ?? this.closest<HTMLElement>("#stories")
      if (!scroller || getTouchGestureAxis(scroller) !== "horizontal") {
        return
      }
      const one_touch = event.touches[0]
      if (!one_touch) {
        return
      }
      event.preventDefault()
      if (start_offset == -1) {
        // Measure from the touchstart, not from here: this handler first runs
        // once the axis lock has resolved, several moves into the gesture, and
        // a flick can cover most of its distance by then. Anchoring here threw
        // that travel away, so a swipe that visibly passed stage 1 could
        // release having registered almost nothing.
        start_offset =
          getTouchGestureStart(scroller)?.x ?? one_touch.clientX
        add_background_element()
      }
      swipe(one_touch.clientX)
    }

    const swipe = (x: number) => {
      drag_offset = x - start_offset
      const next = geometry().plateau(drag_offset)
      const next_stage = geometry().stage(drag_offset)
      if (next === plateau && next_stage === stage) return
      plateau = next
      stage = next_stage
      update_reveal(drag_offset)
      this.style.transition = SWIPE_SNAP_TRANSITION
      this.style.transform = `translateX(${plateau}px)`
    }

    this.addEventListener("touchmove", () => {
      document.addEventListener("touchmove", touch_swipe)
      document.addEventListener("touchend", end_swipe)
      document.addEventListener("touchcancel", cancel_swipe)
      document.addEventListener("pointerup", end_swipe)
      document.addEventListener("pointercancel", cancel_swipe)
      this.parentElement?.addEventListener("scroll", end_swipe)
    })

    this.addEventListener("pointerdown", (e) => {
      // Touch has its own axis-locked path below. Running both pointer and
      // touch handlers lets a vertical scroll/pull move the story as well.
      if (e.pointerType === "touch") {
        return
      }
      if (
        e.button != 0 ||
        (e.target as HTMLElement).getAttribute("draggable") == "false"
      ) {
        e.stopPropagation()
        return
      }
      e.preventDefault()
      // The press is the origin of the drag. Taking it from the first
      // pointermove instead dropped however far the pointer had already
      // travelled — with coalesced moves that is easily past stage 1, which
      // left mid-length drags resting on a plateau but committing nothing.
      start_offset = e.pageX
      document.body.style.cursor = "w-resize"
      document.addEventListener("pointermove", mouse_swipe)
      document.addEventListener("touchmove", touch_swipe)
      document.addEventListener("touchend", end_swipe)
      document.addEventListener("touchcancel", cancel_swipe)
      document.addEventListener("pointerup", end_swipe)
      document.addEventListener("pointercancel", cancel_swipe)
      this.parentElement?.addEventListener("scroll", end_swipe)
    })

    // Releasing ON a plateau fires that stage; releasing below stage 1 fires
    // nothing, which is what makes an abandoned drag safe.
    const end_swipe = (e: Event) => {
      e.preventDefault()
      e.stopPropagation()

      const committed = stage
      const direction = Math.sign(drag_offset)
      reset_swipe()
      commit_swipe(committed, direction)

      return false
    }

    const commit_swipe = (committed: SwipeStage, direction: number) => {
      const action = geometry().actionAt(committed, direction)
      if (this.swipePreview) {
        // A sample row: say what would have happened, change nothing.
        this.swipePreview.onAction(action, committed)
        return
      }
      switch (action) {
        case "none":
          return
        case "open":
          this.read_btn.classList.add("user_interaction")
          this.openStory("_self")
          return
        case "open-browser":
          void executeStoryMenuAction("open-browser", this)
          return
        case "skip":
          // Unconditional, unlike toggle-read: a swipe to skip should skip.
          this.read_btn.classList.add("user_interaction")
          StoryHistory.instance.story_change(
            this.story,
            "skipped",
            this.story.read_state
          )
          void getOnceClient().persistStoryChange(
            this.story.href,
            "read_state",
            "skipped"
          )
          return
        // The rest already exist as menu actions; routing through them keeps
        // reader persistence and the filter dialog in one place.
        case "open-reader":
          void executeStoryMenuAction("open-reader", this)
          return
        case "toggle-read":
          void executeStoryMenuAction("toggle-read", this)
          return
        case "toggle-bookmark":
          void executeStoryMenuAction("toggle-bookmark", this)
          return
        case "filter":
          void executeStoryMenuAction("filter", this)
      }
    }

    // the browser took over the gesture (e.g. Android starts scrolling):
    // reset without triggering a read/skip action
    const cancel_swipe = () => {
      reset_swipe()
    }

    const reset_swipe = () => {
      document.querySelectorAll<HTMLElement>(".bb_slide").forEach((el) => {
        el.remove()
      })
      this.bb_slide = undefined

      start_offset = -1
      plateau = 0
      drag_offset = 0
      stage = 0
      // spring back rather than snapping, so the release reads as a release
      this.style.transition = SWIPE_RELEASE_TRANSITION
      this.style.transform = ""
      document.body.style.cursor = ""
      document.removeEventListener("touchmove", touch_swipe)
      document.removeEventListener("pointermove", mouse_swipe)
      document.removeEventListener("touchend", end_swipe)
      document.removeEventListener("touchcancel", cancel_swipe)
      document.removeEventListener("pointerup", end_swipe)
      document.removeEventListener("pointercancel", cancel_swipe)
      this.parentElement?.removeEventListener("scroll", end_swipe)
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
        if (!requestReading(this.story, "comments")) {
          openStoryUrl(commentsUrl, "_self", false)
        }
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
          const tag_href = tag.href
          tag_el.href = tag_href
          bindLinkBehavior(tag_el, {
            onClick: () => {
              getOnceClient().openUrl(tag_href, "_self")
            },
            onMiddleClick: () => {
              getOnceClient().openUrl(tag_href, "middle")
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

  /**
   * The ⋮ affordance. Hidden by default (Electron and the extensions use their
   * native context menus) and revealed by the touch platforms, which have no
   * such API.
   */
  add_menu_button(): void {
    this.menu_btn = StoryListItem.icon_button("story actions", "menu_btn")
    this.menu_btn.dataset.testid = "story-menu-button"
    this.menu_btn.textContent = "⋮"
    this.menu_btn.setAttribute("aria-haspopup", "menu")
    this.menu_btn.setAttribute("aria-label", "Story actions")
    // Claiming the press keeps swipeable() and the long-press detector from
    // arming, so the button opens the menu on TAP and nothing else fires.
    this.menu_btn.addEventListener("pointerdown", (event) => {
      event.stopPropagation()
    })
    this.menu_btn.addEventListener("click", (event) => {
      event.stopPropagation()
      this.requestMenu()
    })
    this.appendChild(this.menu_btn)
  }

  /** Anchors on the whole row by default so ⋮ and long-press agree. */
  requestMenu(anchor: HTMLElement = this): void {
    this.dispatchEvent(new StoryMenuRequestEvent(this, anchor))
  }

  add_read_button(): void {
    this.read_btn = StoryListItem.icon_button("", "read_btn")
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

    this.star_btn = StoryListItem.icon_button("", "star_btn")
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
    const onMiddleClick = options.onMiddleClick
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
        onMiddleClick()
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
