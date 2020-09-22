import * as menu from "../view/menu"
import { Story } from "../data/Story"
import * as story_list from "../view/StoryList"
import * as stroy_loader from "../data/StoryLoader"
import { StoryListItem } from "../view/StoryListItem"
import * as collectors from "../data/collectors"

export { init_search, search_stories }

function init_search() {
  let searchfield = document.querySelector<HTMLInputElement>("#searchfield")

  window.addEventListener("keyup", (e) => {
    //CTRL + F
    if (e.key == "f" && e.ctrlKey) {
      searchfield.focus()
    }
  })

  searchfield.addEventListener("input", (e) => {
    search_stories(searchfield.value)
  })

  let search_scope = document.querySelector<HTMLInputElement>("#search_scope")
  search_scope.addEventListener("change", (e) => {
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

  let cancel_search_btn = document.querySelector<HTMLElement>(
    "#cancel_search_btn"
  )
  cancel_search_btn.onclick = (x) => {
    searchfield.value = ""
    search_stories("")
  }
}

let specialk: Record<string, Function> = {
  "[ALL]": () => {
    let searchfield = document.querySelector<HTMLInputElement>("#searchfield")
    searchfield.value = ""
    search_stories("")
  },
  "[filtered]": () => {
    let story_container = document.querySelector<HTMLElement>("#stories")
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
  },
}

//TODO: load from plugin files, or in case of domain search attach a special optional function to collectors
let extra_search_providers: Record<
  string,
  { type: "global" | "local"; func: (needle: string) => void }
> = {
  domain: {
    type: "global",
    func: async (needle: string) => {
      let search_scope = document.querySelector<HTMLInputElement>(
        "#search_scope"
      )
      search_scope.value = "global"
      let domain_search_providers = collectors.domain_search_providers()
      domain_search_providers.forEach((dsp) => {
        dsp.domain_search(needle).then((res: Story[]) => {
          add_global_search_results(res)
        })
      })
    },
  },
}

async function search_stories(needle: string) {
  let searchfield = document.querySelector<HTMLInputElement>("#searchfield")
  searchfield.value = needle
  let story_container = document.querySelector<HTMLElement>("#stories")
  let global_search_results = document.querySelector<HTMLElement>(
    "#global_search_results"
  )
  let cancel_search_btn = document.querySelector<HTMLElement>(
    "#cancel_search_btn"
  )
  let search_scope = document.querySelector<HTMLInputElement>("#search_scope")

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

  if (specialk.hasOwnProperty(needle)) {
    specialk[needle]()
    return
  }

  let split = needle.split(":")
  if (split.length > 1) {
    let proto = split.shift()
    needle = split.join(":")
    if (extra_search_providers[proto]) {
      let search_provider = extra_search_providers[proto]
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
    let global_search_providers = collectors.global_search_providers()
    global_search_providers.forEach((gsp) => {
      gsp.global_search(needle).then((results: Story[]) => {
        add_global_search_results(results)
      })
    })

    return
  }

  local_search(needle)
}

async function local_search(needle: string) {
  document.querySelectorAll<StoryListItem>(".story").forEach((story_el) => {
    let find_in = [
      story_el.story.title,
      story_el.story.href,
      story_el.story.type,
      story_el.story.og_href,
    ]

    story_el.story.sources.forEach((source_info) => {
      find_in.push("[" + source_info.type + "]")
      find_in.push(source_info.comment_url)
    })

    let found_index = find_in.findIndex(
      (x) => x != undefined && x.toLowerCase().includes(needle.toLowerCase())
    )

    if (found_index != -1) {
      story_el.classList.remove("nomatch")
    } else {
      story_el.classList.add("nomatch")
    }
  })

  story_list.sort_stories()
}

async function add_global_search_results(search_stories: Story[]) {
  let estories = await stroy_loader.enhance_stories(search_stories, false)

  estories.forEach((story: Story) => {
    story_list.add(story, "global_search_results")
  })

  story_list.sort_stories("global_search_results")
}
