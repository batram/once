import { Story, SortableStory } from "../data/Story"
import { OnceSettings } from "../OnceSettings"
import { StoryListItem } from "../view/StoryListItem"
import * as filters from "../data/StoryFilters"
import { StoryMap, DataChangeEventDetail } from "../data/StoryMap"
import * as story_loader from "../data/StoryLoader"
import { ipcRenderer } from "electron"
import * as search from "../data/search"

export class DataChangeEvent extends Event {
  detail: DataChangeEventDetail

  constructor(typeArg: string, detail: DataChangeEventDetail) {
    super(typeArg)
    this.detail = detail
  }
}

export function init(): void {
  const reload_stories_btn = document.querySelector<HTMLElement>(
    "#reload_stories_btn"
  )
  if (reload_stories_btn) {
    reload_stories_btn.onclick = reload
  }

  remote_story_change()
}

export function remote_story_change(): void {
  ipcRenderer.send("story_map", "subscribe_to_changes")
  ipcRenderer.on(
    "story_map",
    async (event, cmd: "data_change", details: DataChangeEventDetail) => {
      switch (cmd) {
        case "data_change": {
          if (details.story && !(details.story instanceof Story)) {
            details.story = Story.from_obj(details.story)
          }
          console.debug("data_change", details)
          if (details.path && details.path.length != 0) {
            const story_els = document.querySelectorAll(
              `.story[data-href="${details.path[0]}"]`
            )
            story_els.forEach((story_el) => {
              story_el.dispatchEvent(
                new DataChangeEvent("data_change", details)
              )
            })
          }

          break
        }
        default:
          console.log("unhandled story_list", cmd)
          event.returnValue = null
      }
    }
  )

  ipcRenderer.send("settings", "subscribe_to_changes")
  ipcRenderer.on(
    "story_list",
    async (event, cmd: string, ...args: unknown[]) => {
      switch (cmd) {
        case "add_stories":
          add_stories(
            (args[0] as Record<string, unknown>[]).map((story: Story) => {
              return Story.from_obj(story)
            }),
            args[1] as string
          )
          break
        case "reload":
          reload()
          break
        case "refilter":
          refilter()
          break
        default:
          console.log("unhandled story_list", cmd)
          event.returnValue = null
      }
    }
  )
}

function add_stories(stories: Story[], bucket = "stories") {
  stories.forEach((story: Story) => {
    add(story, bucket)
  })

  sort_stories(bucket)

  const searchfield = document.querySelector<HTMLInputElement>("#searchfield")
  const search_scope = document.querySelector<HTMLInputElement>("#search_scope")
  if (searchfield.value != "" && search_scope.value != "global") {
    search.search_stories(searchfield.value)
  }
}

function add(story: Story, bucket = "stories"): void {
  if (!(story instanceof Story)) {
    throw "only stories allowed into the story list"
  }
  if (document.querySelector(`.story[data-href="${story.href}"]`)) {
    console.debug("deduped story ins storylist: ", story.href)
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

function sortable_story(elem: StoryListItem): SortableStory {
  return {
    read_state: elem.story.read_state as "unread" | "read" | "skipped",
    timestamp: elem.story.timestamp,
    el: elem,
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
  const stories = Array.from(story_con.querySelectorAll(".story")).filter(
    (el: HTMLElement) => {
      return getComputedStyle(el).display != "none"
    }
  )

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

  const storted = Array.from(story_con.querySelectorAll(".story"))
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

function refilter(): void {
  document
    .querySelectorAll<StoryListItem>(".story")
    .forEach(async (story_el) => {
      const sthref = story_el.dataset.href
      const story = await StoryMap.remote.get(sthref)
      const og_filter = story.filter
      filters.filter_story(story).then(async (story) => {
        if (story.filter != og_filter) {
          StoryMap.remote.persist_story_change(
            story.href,
            "filter",
            story.filter
          )
          const nstory = new StoryListItem(
            await StoryMap.remote.get(sthref.toString())
          )
          story_el.replaceWith(nstory)
        }
      })
    })
}

async function reload(): Promise<void> {
  document.querySelectorAll(".story").forEach((x) => {
    x.outerHTML = ""
  })

  OnceSettings.remote.grouped_story_sources().then((grouped_story_sources) => {
    story_loader.load(grouped_story_sources)
  })
}
