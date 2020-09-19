import { Story } from "./Story"
import * as settings from "../settings"
import * as menu from "../view/menu"

export {
  filter_story,
  add_filter,
  show_filter_dialog,
  filter_stories,
  get_filterlist,
  show_filter,
}

interface FilterFunc {
  (story: Story): Story
}

let dynamic_filters: Record<string, FilterFunc> = {
  "twitter.com": twitnit,
  "www.reddit.com": old_reddit,
  "youtube.com": youtube_nocookie,
  "youtu.be": youtube_nocookie,
}

function get_filterlist() {
  return settings.get_filterlist()
}

function twitnit(story: Story) {
  story.href = story.href.replace("twitter.com", "nitter.net")
  return story
}

function old_reddit(story: Story) {
  story.href = story.href.replace("www.reddit.com", "old.reddit.com")
  return story
}

function youtube_nocookie(story: Story) {
  story.href = story.href.replace(
    "www.youtube.com/watch?v=",
    "www.youtube-nocookie.com/embed/"
  )
  story.href = story.href.replace(
    "://youtube.com/watch?v=",
    "://www.youtube-nocookie.com/embed/"
  )
  story.href = story.href.replace(
    "://youtu.be/",
    "://www.youtube-nocookie.com/embed/"
  )
  return story
}

function add_filter(filter: string) {
  get_filterlist().then((filter_list: string[]) => {
    filter_list.push(filter)
    settings.save_filterlist(filter_list)
  })
}

async function filter_stories(stories: Story[]) {
  let flist = get_filterlist()
  const filter_list = await get_filterlist()
  return stories.map((story) => {
    return filter_run(filter_list, story)
  })
}

async function filter_story(story: Story) {
  return get_filterlist().then((filter_list: string[]) => {
    return filter_run(filter_list, story)
  })
}

function filter_run(filter_list: string[], story: Story) {
  if (!story.og_href) {
    story.og_href = story.href
  }

  for (let pattern in filter_list) {
    if (
      story.href.includes(filter_list[pattern]) ||
      story.title
        .toLocaleLowerCase()
        .includes(filter_list[pattern].toLocaleLowerCase())
    ) {
      story.filter = filter_list[pattern]
      return story
    }
  }

  for (let pattern in dynamic_filters) {
    if (story.href.includes(pattern)) {
      return dynamic_filters[pattern](story)
    }
  }

  if (story.filter && !story.filter.startsWith("::")) {
    delete story.filter
  }

  return story
}

function show_filter_dialog(
  event: MouseEvent,
  filter_btn: HTMLElement,
  story: Story,
  callback: (filter: string) => any
) {
  event.stopPropagation()
  event.preventDefault()

  let inp = filter_btn.querySelector("input")

  //cancel other open inputs
  document
    .querySelectorAll(".story:not(.filtered) .filter_btn input")
    .forEach((x) => {
      if (inp != x) {
        x.outerHTML = ""
      }
    })

  if (inp) {
    if (event.target != inp) {
      confirm_add_story(inp, filter_btn, callback)
    }
    return
  }

  document.addEventListener("click", (e) => {
    if (e.target != filter_btn) {
      document
        .querySelectorAll(".story:not(.filtered) .filter_btn input")
        .forEach((x) => {
          x.outerHTML = ""
        })
    }
  })

  inp = document.createElement("input")
  inp.type = "text"
  inp.value = new URL(story.href).hostname
  filter_btn.prepend(inp)
  inp.focus()
  inp.addEventListener("keyup", (e) => {
    if (e.keyCode === 27) {
      //ESC
      inp.innerText = "filter"
    } else if (e.keyCode === 13) {
      //ENTER
      confirm_add_story(inp, filter_btn, callback)
    }
  })
}

function confirm_add_story(
  inp: HTMLInputElement,
  filter_btn: HTMLElement,
  callback: (filter: string) => any
) {
  if (confirm('add filter: "' + inp.value + '"')) {
    callback(inp.value)
    inp.outerHTML = ""
  }
}

function show_filter(value: string) {
  if (value.startsWith(":: ")) {
    confirm("internal filter not changeable yet ...")
    return
  }
  let filter_area = document.querySelector<HTMLInputElement>("#filter_area")

  let start = filter_area.value.indexOf(value)
  if (start == -1) {
    confirm("Sorry I seem to have lost that fitler.")
    return
  }

  menu.open_panel("settings")
  let end = start + value.length

  filter_area.focus()

  filter_area.scrollTop = 0
  const fullText = filter_area.value
  filter_area.value = fullText.substring(0, end)
  filter_area.scrollTop = filter_area.scrollHeight
  filter_area.value = fullText

  filter_area.setSelectionRange(start, end)
}
