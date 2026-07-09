import { Story, SortableStory } from "@once/core"
import { StoryListItem } from "./StoryListItem"
import { applyStoryFilter } from "@once/core"
import { StoryChangeDetail, OnceClient } from "@once/app"
import * as Search from "./search"
import { URLRedirect } from "@once/core"

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

  remote_story_change(client)
}

export function remote_story_change(client = onceClient): void {
  client.subscribe("storyChanged", (details) => {
    if (details.story && !(details.story instanceof Story)) {
      details.story = Story.from_obj(details.story)
    }
    if (details.path && details.path.length != 0) {
      const story_els = document.querySelectorAll(
        `.story[data-href="${details.path[0]}"]`
      )
      story_els.forEach((story_el) => {
        story_el.dispatchEvent(new DataChangeEvent("data_change", details))
      })
    }
  })
  client.subscribe("storiesChanged", ({ stories, bucket, replace }) => {
    if (replace) {
      document.querySelectorAll(`#${bucket} .story`).forEach((x) => {
        x.outerHTML = ""
      })
    }
    add_stories(stories, bucket)
  })
  client.subscribe("settingsChanged", ({ section }) => {
    if (section === "filters") {
      refilter()
    }
  })
  client.subscribe("redirectsChanged", () => {
    update_redirects()
  })
}

function add_stories(stories: Story[], bucket = "stories") {
  stories.forEach((story: Story) => {
    add(story, bucket)
  })

  sort_stories(bucket)

  const searchfield = document.querySelector<HTMLInputElement>("#searchfield")
  const search_scope = document.querySelector<HTMLInputElement>("#search_scope")
  if (searchfield.value != "" && search_scope.value != "global") {
    Search.searchStories(searchfield.value)
  }
}

function add(story: Story, bucket = "stories"): void {
  if (!(story instanceof Story)) {
    throw "only stories allowed into the story list"
  }
  if (document.querySelector(`.story[data-href="${story.href}"]`)) {
    //console.debug("deduped story ins storylist: ", story.href, story.title)
    return
  }

  story.bucket = bucket

  const new_story_el = new StoryListItem(story)
  const stories_container = document.querySelector("#" + bucket)

  //hide new stories if search is active, will be matched and shown later
  const searchfield = document.querySelector<HTMLInputElement>("#searchfield")
  if (searchfield.value != "" && bucket != "global_search_results") {
    new_story_el.classList.add("nomatch")
  }

  stories_container.appendChild(new_story_el)
}

export function get_by_href(url: string): StoryListItem {
  let story_el = null

  const info_can = document.querySelector<StoryListItem>(
    `.story a[href="${url}"]`
  )
  if (info_can) {
    let parent = info_can.parentElement
    let max = 5
    while (!(parent.tagName == "STORY-ITEM") && max > 0) {
      max -= 1
      parent = parent.parentElement

      if (parent.tagName == "STORY-ITEM") {
        story_el = parent
        break
      }
    }
  }

  return story_el as StoryListItem
}

function sortable_story(elem: StoryListItem): SortableStory<StoryListItem> {
  return {
    read_state: elem.story.read_state as "unread" | "read" | "skipped",
    timestamp: elem.story.timestamp,
    el: elem
  }
}

export function resort_single(elem: StoryListItem): () => void {
  const story_con = elem.parentElement
  if (!story_con) {
    console.debug(
      "resort_single: cant sort that which is not contained",
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

  let insert_before_el: HTMLElement = null
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

export function sort_stories(bucket = "stories"): void {
  const story_con = document.querySelector("#" + bucket)

  const storted = Array.from(story_con.querySelectorAll<StoryListItem>(".story"))
    .map(sortable_story)
    .sort(Story.compare)

  storted.forEach((x) => {
    const paw = x.el.parentElement
    paw.appendChild(x.el)
    if (x.el.classList.contains("read_anim")) {
      setTimeout(() => {
        x.el.classList.remove("read_anim")
      }, 1)
    }
    if (x.el.classList.contains("unread_anim")) {
      setTimeout(() => {
        x.el.classList.remove("unread_anim")
      }, 1)
    }
  })
}

export const getByHref = get_by_href
export const resortSingle = resort_single
export const sortStories = sort_stories

function refilter(): void {
  document
    .querySelectorAll<StoryListItem>(".story")
    .forEach(async (story_el) => {
      const sthref = story_el.dataset.href
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
          og_link.style.display = "none"
        } else {
          og_link.style.display = ""
        }
      }
    }
  })
}
