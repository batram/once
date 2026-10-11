import { Story, SortableStory } from "@once/core"
import { StoryListItem } from "./StoryListItem"
import { applyStoryFilter } from "@once/core"
import { CachePolicy, StoryChangeDetail, OnceClient } from "@once/app"
import * as StorySearch from "./storySearch"
import { URLRedirect } from "@once/core"
import { requireElement } from "../dom"
import { attachPullToRefresh } from "../gesture/pullToRefresh"
import { isTouchGestureActive } from "../gesture/touchGestureLock"
import { placeInOrder } from "./storyOrder"
import { connectStoryListSync } from "./storyListSync"
import { visibleStoryElements } from "./storyVisibility"
import { getKeyboardDispatcher } from "../keyboard"

export class DataChangeEvent extends Event {
  detail: StoryChangeDetail

  constructor(typeArg: string, detail: StoryChangeDetail) {
    super(typeArg)
    this.detail = detail
  }
}

let onceClient: OnceClient
// Shells that report reload progress elsewhere cap the spinners at this many
// ms; the reload itself runs to completion either way.
let spinTimeout: number | undefined

export interface StoryListOptions {
  spinTimeout?: number
}

export function init(client: OnceClient, options: StoryListOptions = {}): void {
  onceClient = client
  spinTimeout = options.spinTimeout
  const reload_stories_btn = document.querySelector<HTMLElement>(
    "#reload_stories_btn"
  )
  if (reload_stories_btn) {
    let clickTimeout: NodeJS.Timeout | null = null

    reload_stories_btn.onclick = () => {
      if (reload_stories_btn.classList.contains("disabled")) return
      console.log("reload_stories_btn clicked")
      if (clickTimeout) clearTimeout(clickTimeout)
      clickTimeout = setTimeout(() => {
        reload("cache-first")
        clickTimeout = null
      }, 250)
    }
    reload_stories_btn.ondblclick = () => {
      if (reload_stories_btn.classList.contains("disabled")) return
      console.log("reload_stories_btn double clicked")
      if (clickTimeout) {
        clearTimeout(clickTimeout)
        clickTimeout = null
      }
      reload("network-only")
    }
  }

  // The two reloads the button already offers, without the click timer that
  // has to tell one from the other: a plain key is the single click, and the
  // shifted key the double. The disabled class is the in-flight guard, so
  // holding a key cannot stack reloads any more than clicking fast can.
  const keyboard = getKeyboardDispatcher()
  const reloadFromKeyboard = (policy: CachePolicy) => () => {
    if (reload_stories_btn?.classList.contains("disabled")) return
    void reload(policy, "keyboard")
  }
  keyboard.register("stories.reload", reloadFromKeyboard("cache-first"))
  keyboard.register(
    "stories.reload-uncached",
    reloadFromKeyboard("network-only")
  )

  connectStoryListSync(client, {
    addStories(stories, bucket, replace) {
      if (replace) {
        document.querySelectorAll(`#${bucket} .story`).forEach((story) => {
          story.remove()
        })
      }
      add_stories(stories, bucket)
    },
    updateStory(details) {
      if (!details.path || details.path.length === 0) return
      storyElementsForHref(details.path[0]).forEach((story) => {
        story.dispatchEvent(new DataChangeEvent("data_change", details))
      })
    },
    removeStory(href) {
      storyElementsForHref(href).forEach((story) => story.remove())
    },
    settingsChanged(section) {
      if (section === "filters") refilter()
    },
    redirectsChanged() {
      update_redirects()
    }
  })

  // Pull down past the top of the story list to reload (touch only — inert for
  // pointer users, who still have the reload button above).
  const stories_el = document.querySelector<HTMLElement>("#stories")
  if (stories_el) {
    attachPullToRefresh(stories_el, () => reload("network-only", "pull"), { spinTimeout })
  }
}

function add_stories(stories: Story[], bucket = "stories") {
  // One lookup table per batch: scanning every row for every story made a
  // source's batch cost its size times the whole list.
  const rows = rowsByHref()
  stories.forEach((story: Story) => {
    add(story, bucket, rows)
  })

  sortStories(bucket)

  const searchfield = requireElement<HTMLInputElement>("#searchfield")
  const search_scope = requireElement<HTMLInputElement>("#search_scope")
  if (
    searchfield.value != "" &&
    search_scope.value != "global"
  ) {
    StorySearch.searchStories(searchfield.value)
  }
}

function add(
  story: Story,
  bucket: string,
  rows: Map<string, StoryListItem[]>
): void {
  if (!(story instanceof Story)) {
    throw new TypeError("Only Story instances can be added to the story list")
  }

  const existingStories = rows.get(story.href) ?? []
  if (existingStories.length > 0) {
    // storiesChanged is an upsert, not an insert-only hint. This also repairs
    // a stale row if presentation and the app working set ever diverge. A row
    // that already shows the story only takes the new instance: redrawing it
    // would pull the element out from under a finger mid-swipe or mid-tap.
    existingStories.forEach((existing) => {
      if (existing.shows(story)) {
        existing.story = story
        return
      }
      existing.dispatchEvent(
        new DataChangeEvent("data_change", {
          story,
          path: [story.href],
          value: story,
          previousValue: existing.story,
          name: null,
          animated: false
        })
      )
    })
    return
  }

  story.bucket = bucket

  const new_story_el = new StoryListItem(story)
  const stories_container = requireElement("#" + bucket)

  //hide new stories if search is active, will be matched and shown later
  const searchfield = requireElement<HTMLInputElement>("#searchfield")
  if (
    searchfield.value != "" &&
    bucket != "global_search_results"
  ) {
    new_story_el.classList.add("nomatch")
  }

  stories_container.appendChild(new_story_el)
  rows.set(story.href, [new_story_el])
}

function rowsByHref(): Map<string, StoryListItem[]> {
  const rows = new Map<string, StoryListItem[]>()
  document.querySelectorAll<StoryListItem>(".story[data-href]").forEach((row) => {
    const href = row.dataset.href
    if (href === undefined) return
    const list = rows.get(href)
    if (list) list.push(row)
    else rows.set(href, [row])
  })
  return rows
}

function storyElementsForHref(href: string): StoryListItem[] {
  return Array.from(
    document.querySelectorAll<StoryListItem>(".story[data-href]")
  ).filter((story) => story.dataset.href === href)
}

function sortable_story(elem: StoryListItem): SortableStory<StoryListItem> {
  return {
    read_state: elem.story.read_state as "unread" | "read" | "skipped",
    timestamp: elem.story.timestamp,
    el: elem
  }
}

/**
 * The main list sinks read stories below unread ones. Global search results
 * show their read state on the row but stay in time order: they are a hit list,
 * and a row jumping away after a click is not what a search wants.
 */
function comparatorFor(
  story_con: Element
): (a: SortableStory<StoryListItem>, b: SortableStory<StoryListItem>) => number {
  if (story_con.id !== "global_search_results") return Story.compare
  return (a, b) =>
    Story.compare(
      { ...a, read_state: "unread" },
      { ...b, read_state: "unread" }
    )
}

export function resortSingle(elem: StoryListItem): (() => void) | null {
  const story_con = elem.parentElement
  if (!story_con) {
    console.debug(
      "resortSingle: cannot sort an item without a parent",
      "story_el has no parent"
    )
    return null
  }
  const stories = Array.from(
    story_con.querySelectorAll<StoryListItem>(".story")
  ).filter((el: StoryListItem) => {
    return getComputedStyle(el).display != "none"
  })

  const stories_sorted = stories
    .map(sortable_story)
    .sort(comparatorFor(story_con))
    .map((x) => x.el)
    .filter((el): el is StoryListItem => el != undefined)

  let insert_before_el: HTMLElement | null = null
  const sorted_pos = stories_sorted.indexOf(elem)

  if (stories.indexOf(elem) == sorted_pos) {
    //don't need to resort, would keep our position
    return null
  } else if (sorted_pos != stories_sorted.length - 1) {
    insert_before_el = stories_sorted[sorted_pos + 1]
  }

  return () => {
    if (!insert_before_el) {
      story_con.appendChild(elem)
    } else {
      story_con.insertBefore(elem, insert_before_el)
    }
    setTimeout(() => {
      elem.classList.forEach((class_name) => {
        if (class_name.endsWith("_anim")) {
          elem.classList.remove(class_name)
        }
      })
    }, 1)
  }
}

// Buckets whose sort waits for the finger to lift; see sortStories.
const sortsAwaitingRelease = new Set<string>()

function sortOnRelease(bucket: string, story_con: HTMLElement): void {
  if (sortsAwaitingRelease.has(bucket)) return
  sortsAwaitingRelease.add(bucket)
  const release = () => {
    story_con.removeEventListener("touchend", release)
    story_con.removeEventListener("touchcancel", release)
    sortsAwaitingRelease.delete(bucket)
    // After this turn, so the gesture's own release handler has let go.
    setTimeout(() => sortStories(bucket), 0)
  }
  story_con.addEventListener("touchend", release)
  story_con.addEventListener("touchcancel", release)
}

export function sortStories(bucket = "stories"): void {
  const story_con = requireElement<HTMLElement>("#" + bucket)

  // A reload sorting the list while a finger is on it moves rows under the
  // touch: a tap opens a different story, a swipe judges the wrong one. The
  // new rows are already appended at the end; they find their place once the
  // finger lifts.
  if (isTouchGestureActive(story_con)) {
    sortOnRelease(bucket, story_con)
    return
  }

  const rows = Array.from(story_con.children)
    .filter((child): child is StoryListItem => child.classList.contains("story"))
  const storted = rows
    .map(sortable_story)
    .sort(comparatorFor(story_con))
  placeInOrder(story_con, storted.flatMap((x) => (x.el ? [x.el] : [])))

  storted.forEach((x) => {
    const el = x.el
    if (!el) {
      return
    }
    if (el.classList.contains("read_anim")) {
      setTimeout(() => {
        el.classList.remove("read_anim")
      }, 1)
    }
    if (el.classList.contains("unread_anim")) {
      setTimeout(() => {
        el.classList.remove("unread_anim")
      }, 1)
    }
  })
}

/** Current rendered order, excluding rows hidden by search or filtering. */
export function visibleStories(bucket = "stories"): Story[] {
  return visibleStoryElements(bucket).map((row) => row.story)
}

function refilter(): void {
  document
    .querySelectorAll<StoryListItem>(
      ".stories_container > story-item.story"
    )
    .forEach(async (story_el) => {
      const story = story_el.story
      const og_filter = story.filter
      onceClient.getFilterList().then((filterList) => {
        const filteredStory = applyStoryFilter(filterList, story)
        if (story.filter != og_filter) {
          onceClient.persistStoryChange(
            filteredStory.href,
            "filter",
            filteredStory.filter
          )
          const nstory = new StoryListItem(filteredStory)
          story_el.replaceWith(nstory)
        }
      })
    })
}

/** Dispatched on `document` when a reload starts; `detail` names its trigger. */
export const STORY_RELOAD_STARTED = "once:story-reload"
export type StoryReloadTrigger = "button" | "keyboard" | "pull"

async function reload(
  policy: CachePolicy = "cache-first",
  trigger: StoryReloadTrigger = "button"
): Promise<void> {
  console.log("reload called, policy:", policy, "trigger:", trigger)
  document.dispatchEvent(new CustomEvent(STORY_RELOAD_STARTED, { detail: trigger }))
  const btn = document.querySelector("#reload_stories_btn")
  const btnIcon = btn?.querySelector(".icon--reload")
  btn?.classList.add("disabled")
  btnIcon?.classList.add("rotating")
  // The button stays disabled for the whole reload; only its spin is capped.
  const spinCap = spinTimeout === undefined
    ? null
    : setTimeout(() => btnIcon?.classList.remove("rotating"), spinTimeout)

  try {
    await onceClient.reloadStories(policy)
  } finally {
    if (spinCap !== null) clearTimeout(spinCap)
    btn?.classList.remove("disabled")
    btnIcon?.classList.remove("rotating")
  }
}

function update_redirects(): void {
  document.querySelectorAll<StoryListItem>(".story").forEach((story_el) => {
    const href = story_el.dataset.href
    if (href) {
      const redirected_url = URLRedirect.redirect_url(href)
      // Add-on views and conditions read the row's redirected URL, not the link.
      story_el.dataset.redirected_url = redirected_url
      const title_link = story_el.querySelector("a.title") as HTMLAnchorElement
      if (title_link) {
        title_link.href = redirected_url
      }
      const og_link = story_el.querySelector("a.og_href") as HTMLAnchorElement
      if (og_link) {
        og_link.href = href
        // Hide OG link if it's the same as redirected URL
        if (title_link && title_link.href == og_link.href) {
          og_link.classList.add("story-link-hidden")
        } else {
          og_link.classList.remove("story-link-hidden")
        }
      }
    }
  })
}
