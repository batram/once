import { Story } from "./Story"
import * as menu from "../view/menu"
import { OnceSettings } from "../OnceSettings"
import { filter_url } from "../data/URLFilters"

export {
  filter_story,
  add_filter,
  show_filter_dialog,
  filter_stories,
  show_filter,
}

function add_filter(filter: string): void {
  OnceSettings.instance.get_filterlist().then((filter_list: string[]) => {
    filter_list.push(filter)
    OnceSettings.instance.save_filterlist(filter_list)
  })
}

async function filter_stories(stories: Story[]): Promise<Story[]> {
  const filter_list = await OnceSettings.instance.get_filterlist()
  return stories.map((story) => {
    return filter_run(filter_list, story)
  })
}

async function filter_story(story: Story): Promise<Story> {
  return OnceSettings.instance
    .get_filterlist()
    .then((filter_list: string[]) => {
      return filter_run(filter_list, story)
    })
}

function filter_run(filter_list: string[], story: Story) {
  if (!story.og_href) {
    story.og_href = story.href
  }

  for (const pattern in filter_list) {
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

  story.href = filter_url(story.href)

  if (story.filter && !story.filter.startsWith("::")) {
    delete story.filter
  }

  return story
}

function show_filter_dialog(
  event: MouseEvent,
  filter_btn: HTMLElement,
  story: Story,
  callback: (filter: string) => unknown
): void {
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
      confirm_add_story(inp, callback)
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
      confirm_add_story(inp, callback)
    }
  })
}

function confirm_add_story(
  inp: HTMLInputElement,
  callback: (filter: string) => unknown
) {
  if (confirm(`add filter: "${inp.value}"`)) {
    callback(inp.value)
    inp.outerHTML = ""
  }
}

function show_filter(value: string): void {
  if (value.startsWith(":: ")) {
    confirm("internal filter not changeable yet ...")
    return
  }
  const filter_area = document.querySelector<HTMLInputElement>("#filter_area")

  const start = filter_area.value.indexOf(value)
  if (start == -1) {
    confirm("Sorry I seem to have lost that fitler.")
    return
  }

  menu.open_panel("settings")
  const end = start + value.length

  filter_area.focus()

  filter_area.scrollTop = 0
  const fullText = filter_area.value
  filter_area.value = fullText.substring(0, end)
  filter_area.scrollTop = filter_area.scrollHeight
  filter_area.value = fullText

  filter_area.setSelectionRange(start, end)
}
