import { Story, SortableStory } from "@once/core"
import { StoryListItem } from "./StoryListItem"
import { applyStoryFilter } from "@once/core"
import { StoryChangeDetail, OnceClient } from "@once/app"
import * as StorySearch from "./storySearch"
import { URLRedirect } from "@once/core"
import { requireElement } from "../dom"
import { attachPullToRefresh } from "../gesture/pullToRefresh"
import { connectStoryListSync } from "./storyListSync"

export class DataChangeEvent extends Event {
  detail: StoryChangeDetail

  constructor(typeArg: string, detail: StoryChangeDetail) {
    super(typeArg)
    this.detail = detail
  }
}

let onceClient: OnceClient

export function init(client: OnceClient): void {
  onceClient = client
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
        reload(true)
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
      reload(false)
    }
  }

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
    attachPullToRefresh(stories_el, () => reload(true))
  }
}

// Startup source loads need the network and can fail (offline, flaky mobile
// radio); fall back to the persisted stories so local data is never hidden
// behind an empty list.
export async function showStoredStoriesIfEmpty(client: OnceClient): Promise<void> {
  if (document.querySelector("#stories .story")) return
  add_stories(await client.getStories())
}

function add_stories(stories: Story[], bucket = "stories") {
  stories.forEach((story: Story) => {
    add(story, bucket)
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

function add(story: Story, bucket = "stories"): void {
  if (!(story instanceof Story)) {
    throw new TypeError("Only Story instances can be added to the story list")
  }

  const existingStories = storyElementsForHref(story.href)
  if (existingStories.length > 0) {
    // storiesChanged is an upsert, not an insert-only hint. This also repairs
    // a stale row if presentation and the app working set ever diverge.
    existingStories.forEach((existing) => {
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
    .sort(Story.compare)
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

export function sortStories(bucket = "stories"): void {
  const story_con = requireElement("#" + bucket)

  const storted = Array.from(story_con.querySelectorAll<StoryListItem>(".story"))
    .map(sortable_story)
    .sort(Story.compare)

  storted.forEach((x) => {
    const el = x.el
    if (!el) {
      return
    }
    el.parentElement?.appendChild(el)
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
  const container = requireElement("#" + bucket)
  return Array.from(
    container.querySelectorAll<StoryListItem>("story-item.story")
  )
    .filter((row) =>
      !row.classList.contains("nomatch") &&
      !row.classList.contains("filtered") &&
      getComputedStyle(row).display !== "none"
    )
    .map((row) => row.story)
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

async function reload(try_cache = true): Promise<void> {
  console.log("reload called, try_cache:", try_cache)
  const btn = document.querySelector("#reload_stories_btn")
  const btn_img = btn?.querySelector("img")
  btn?.classList.add("disabled")
  btn_img?.classList.add("rotating")

  try {
    document.querySelectorAll("#stories .story").forEach((x) => {
      x.outerHTML = ""
    })

    await onceClient.reloadStories(try_cache)
  } finally {
    btn?.classList.remove("disabled")
    btn_img?.classList.remove("rotating")
  }
}

function update_redirects(): void {
  document.querySelectorAll<StoryListItem>(".story").forEach((story_el) => {
    const href = story_el.dataset.href
    if (href) {
      const redirected_url = URLRedirect.redirect_url(href)
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
