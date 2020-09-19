import { Story, SortableStory } from "../data/Story"
import { get_starlist, get_readlist, story_sources } from "../settings"
import * as story_item from "../view/StoryListItem"
import * as filters from "../data/filters"
import { StoryMap } from "../data/StoryMap"
import * as story_loader from "../data/StoryLoader"

export {
  mark_selected,
  get_by_href,
  reload,
  refilter,
  restar,
  sort_stories,
  resort_single,
  add,
  reread,
  init,
}

function init() {
  let reload_stories_btn = document.querySelector<HTMLElement>(
    "#reload_stories_btn"
  )
  if (reload_stories_btn) {
    reload_stories_btn.onclick = reload
  }
}

function add(story: Story, bucket = "stories") {
  if (!(story instanceof Story)) {
    story = Story.from_obj(story)
    story = StoryMap.instance.set(story.href.toString(), story)
  }

  story.bucket = bucket

  let new_story_el = story_item.story_html(story)
  let stories_container = document.querySelector("#" + bucket)

  //hide new stories if search is active, will be matched and shown later
  let searchfield = document.querySelector<HTMLInputElement>("#searchfield")
  if (searchfield.value != "" && bucket != "global_search_results") {
    new_story_el.classList.add("nomatch")
  }

  stories_container.appendChild(new_story_el)
}

function get_by_href(url: string) {
  let story_el = null

  let info_can = document.querySelector(`.story a[href="${url}"]`)
  if (info_can) {
    let parent = info_can.parentElement
    let max = 5
    while (!parent.classList.contains("story") && max > 0) {
      max -= 1
      parent = parent.parentElement

      if (parent.classList.contains("story")) {
        story_el = parent
        break
      }
    }
  }

  return story_el
}

function mark_selected(story_el: HTMLElement, url: string) {
  if (!story_el && url) {
    story_el = get_by_href(url)
  }

  document.querySelectorAll(".story").forEach((x: HTMLElement) => {
    if (x.classList.contains("selected")) {
      x.classList.remove("selected")
      let fun = resort_single(x)
      if (typeof fun == "function") {
        fun()
      }
    }
  })

  if (story_el) {
    story_el.classList.add("selected")
    let og_story = StoryMap.instance.get(story_el.dataset.href)
    if (og_story.href == url) {
      og_story.mark_as_read()
    }
    return og_story
  } else {
    return null
  }
}

function story_compare(a: SortableStory, b: SortableStory) {
  //sort by read first and then timestamp
  if (a.read && !b.read) {
    return 1
  } else if (!a.read && b.read) {
    return -1
  } else if ((a.read && b.read) || (!a.read && !b.read)) {
    if (a.timestamp > b.timestamp) return -1
    if (a.timestamp < b.timestamp) return 1
    return 0
  }
  if (a.timestamp > b.timestamp) return -1
  if (a.timestamp < b.timestamp) return 1
  return 0
}

function sortable_story(elem: HTMLElement) {
  return {
    read: elem.classList.contains("read"),
    timestamp: elem.dataset.timestamp,
    el: elem,
  }
}

function resort_single(elem: HTMLElement) {
  let story_con = elem.parentElement
  let stories = Array.from(story_con.querySelectorAll(".story")).filter(
    (el: HTMLElement) => {
      return (
        getComputedStyle(el).display != "none" &&
        !el.classList.contains("selected")
      )
    }
  )

  let stories_sorted = stories
    .map(sortable_story)
    .sort(story_compare)
    .map((x) => x.el)

  let insert_before_el: HTMLElement = null
  let sorted_pos = stories_sorted.indexOf(elem)

  if (stories.indexOf(elem) == sorted_pos) {
    //don't need to resort, would keep our position
    return false
  } else if (sorted_pos != stories_sorted.length - 1) {
    insert_before_el = stories_sorted[sorted_pos + 1]
  }

  return () => {
    if (!insert_before_el) {
      story_con.appendChild(elem)
    } else {
      story_con.insertBefore(elem, insert_before_el)
    }

    if (elem.classList.contains("read_anim")) {
      setTimeout((t) => {
        elem.classList.remove("read_anim")
      }, 1)
    }
    if (elem.classList.contains("unread_anim")) {
      setTimeout((t) => {
        elem.classList.remove("unread_anim")
      }, 1)
    }
  }
}

function sort_stories(bucket = "stories") {
  let story_con = document.querySelector("#" + bucket)

  let storted = Array.from(story_con.querySelectorAll(".story"))
    .map(sortable_story)
    .sort(story_compare)

  storted.forEach((x) => {
    let paw = x.el.parentElement
    paw.appendChild(x.el)
    if (x.el.classList.contains("read_anim")) {
      setTimeout((t) => {
        x.el.classList.remove("read_anim")
      }, 1)
    }
    if (x.el.classList.contains("unread_anim")) {
      setTimeout((t) => {
        x.el.classList.remove("unread_anim")
      }, 1)
    }
  })
}

async function restar() {
  let starlist = await get_starlist()
  document.querySelectorAll<HTMLElement>(".story").forEach((story_el) => {
    let sthref = story_el.dataset.href
    let story = StoryMap.instance.get(sthref.toString())
    story.stared = starlist.hasOwnProperty(sthref)
  })

  story_loader.add_stored_stars(starlist)
}

async function reread(readlist: any) {
  StoryMap.instance.forEach((story: any) => {
    story.read = readlist.includes(story.href)
  })
}

function refilter() {
  document.querySelectorAll<HTMLElement>(".story").forEach((x) => {
    let sthref = x.dataset.href.toString()
    let story = StoryMap.instance.get(sthref.toString())
    let og_filter = story.filter
    filters.filter_story(story).then((story) => {
      if (story.filter != og_filter) {
        let nstory = story_item.story_html(
          StoryMap.instance.get(sthref.toString())
        )
        x.replaceWith(nstory)
      }
    })
  })
}

function reload() {
  //dont remove the selected story on reload
  let selected = document.querySelector<HTMLElement>(".selected")
  if (selected) {
    let href = selected.dataset.href
    let story = StoryMap.instance.get(href).clone()
    StoryMap.instance.clear()
    StoryMap.instance.set(href, story)
  } else {
    StoryMap.instance.clear()
  }

  document.querySelectorAll(".story").forEach((x) => {
    if (!x.classList.contains("selected")) {
      x.outerHTML = ""
    }
  })

  story_sources().then(story_loader.load)
}
