import { Story } from "@once/core"
import * as StoryList from "./StoryList"
import { StoryListItem } from "./StoryListItem"
import {
  domain_search_providers,
  global_search_providers
} from "@once/collectors"
import { applyStoryFilters } from "@once/core"
import { getOnceClient } from "./client"

export function init_search(): void {
  const searchfield = document.querySelector<HTMLInputElement>("#searchfield")

  window.addEventListener("keyup", (e) => {
    //CTRL + F
    if (e.key == "f" && e.ctrlKey) {
      searchfield.focus()
    }
  })
  const search_scope = document.querySelector<HTMLInputElement>("#search_scope")

  searchfield.addEventListener("input", () => {
    if (search_scope.value == "local") {
      search_stories(searchfield.value)
    }
  })

  search_scope.addEventListener("change", () => {
    if (searchfield.value != "") {
      search_stories(searchfield.value)
    }
  })

  searchfield.addEventListener("keyup", (e) => {
    if (e.keyCode === 27) {
      //ESC
      searchfield.value = ""
      search_stories(searchfield.value)
    } else if (e.keyCode === 13) {
      //ENTER
      search_stories(searchfield.value)
    }
  })

  const cancel_search_btn =
    document.querySelector<HTMLElement>("#cancel_search_btn")
  cancel_search_btn.onclick = () => {
    searchfield.value = ""
    search_stories("")
  }
}

const specialk: Record<string, () => void> = {
  "[ALL]": () => {
    const searchfield = document.querySelector<HTMLInputElement>("#searchfield")
    searchfield.value = ""
    search_stories("")
  },
  "[filtered]": () => {
    const story_container = document.querySelector<HTMLElement>("#stories")
    story_container.classList.add("show_filtered")
    document.querySelectorAll(".story").forEach((x) => {
      x.classList.remove("nomatch")
      if (!x.classList.contains("filtered")) {
        x.classList.add("nomatch")
      }
    })
  },
  "[stared]": () => {
    document.querySelectorAll(".story").forEach((x) => {
      x.classList.add("nomatch")
      if (x.classList.contains("stared")) {
        x.classList.remove("nomatch")
      }
    })
  },
  "[new]": () => {
    document.querySelectorAll(".story").forEach((x) => {
      x.classList.add("nomatch")
      if (!x.classList.contains("read")) {
        x.classList.remove("nomatch")
      }
    })
  }
}

//TODO: load from plugin files, or in case of domain search attach a special optional function to collectors
const extra_search_providers: Record<
  string,
  { type: "global" | "local"; func: (needle: string) => void }
> = {
  domain: {
    type: "global",
    func: async (needle: string) => {
      const search_scope =
        document.querySelector<HTMLInputElement>("#search_scope")
      search_scope.value = "global"
      domain_search_providers().forEach((dsp) => {
        dsp.domain_search(needle).then((res: Story[]) => {
          add_global_search_results(res)
        })
      })
    }
  }
}

export async function search_stories(needle: string): Promise<void> {
  const searchfield = document.querySelector<HTMLInputElement>("#searchfield")
  searchfield.value = needle
  const story_container = document.querySelector<HTMLElement>("#stories")
  const global_search_results = document.querySelector<HTMLElement>(
    "#global_search_results"
  )
  const cancel_search_btn =
    document.querySelector<HTMLElement>("#cancel_search_btn")
  const search_scope = document.querySelector<HTMLInputElement>("#search_scope")

  story_container.classList.remove("show_filtered")
  story_container.style.display = "flex"
  global_search_results.style.display = "none"

  if (needle && needle != "") {
    cancel_search_btn.style.visibility = "visible"
    story_container.classList.add("show_stored_star")
  } else {
    cancel_search_btn.style.visibility = "hidden"
    story_container.classList.remove("show_stored_star")
  }

  if (Object.prototype.hasOwnProperty.call(specialk, needle)) {
    specialk[needle]()
    return
  }

  const split = needle.split(":")
  if (split.length > 1) {
    const proto = split.shift()
    needle = split.join(":")
    if (extra_search_providers[proto]) {
      const search_provider = extra_search_providers[proto]
      if (search_provider.type == "global") {
        global_search_results.style.display = "flex"
        story_container.style.display = "none"
        global_search_results.innerHTML = ""
      }

      extra_search_providers[proto].func(needle)
      return
    }
  }

  if (needle != "" && search_scope.value == "global") {
    global_search_results.style.display = "flex"
    story_container.style.display = "none"
    global_search_results.innerHTML = ""
    global_search_providers().forEach((gsp) => {
      gsp.global_search(needle).then((results: Story[]) => {
        add_global_search_results(results)
      })
    })

    return
  }

  local_search(needle)
}

export const init = init_search
export const searchStories = search_stories

async function local_search(needle: string) {
  document.querySelectorAll<StoryListItem>(".story").forEach((story_el) => {
    const find_in = [
      story_el.story.title,
      story_el.story.href,
      "[" + story_el.story.type + "]",
      story_el.dataset.redirected_url
    ]

    if (story_el.story.tags) {
      story_el.story.tags.forEach((tag_info) => {
        find_in.push(tag_info.text)
        if (tag_info.href) {
          find_in.push(tag_info.href)
        }
      })
    }

    story_el.story.substories.forEach((source_info) => {
      find_in.push("[" + source_info.type + "]")
      find_in.push(source_info.comment_url)
      if (source_info.tags) {
        source_info.tags.forEach((tag_info) => {
          find_in.push(tag_info.text)
          if (tag_info.href) {
            find_in.push(tag_info.href)
          }
        })
      }
    })

    const found_index = find_in.findIndex(
      (x) => x != undefined && x.toLowerCase().includes(needle.toLowerCase())
    )

    if (found_index != -1) {
      story_el.classList.remove("nomatch")
    } else {
      story_el.classList.add("nomatch")
    }
  })

  StoryList.sortStories()
}

async function add_global_search_results(search_stories: Story[]) {
  const filterList = await getOnceClient().getFilterList()
  const filtered_stories = applyStoryFilters(filterList, search_stories)
  const global_search_results = document.querySelector<HTMLElement>(
    "#global_search_results"
  )
  filtered_stories.forEach((story) => {
    if (!global_search_results.querySelector(`.story[data-href="${story.href}"]`)) {
      story.bucket = "global_search_results"
      global_search_results.appendChild(new StoryListItem(story))
    }
  })
  StoryList.sortStories("global_search_results")
}
