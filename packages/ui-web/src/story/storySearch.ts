import { Story } from "@once/core"
import * as StoryList from "./storyList"
import { StoryListItem } from "./StoryListItem"
import { applyStoryFilters } from "@once/core"
import { site_search_providers } from "@once/collectors"
import { getOnceClient } from "../client"
import { getKeyboardDispatcher } from "../keyboard"
import { requireElement } from "../dom"
import { searchableStoryElements } from "./storySearchScope"
import { adoptStoredStoryState } from "./storySearchState"

export function init(): void {
  const searchfield =
    requireElement<HTMLInputElement>("#searchfield")
  const search_scope =
    requireElement<HTMLInputElement>("#search_scope")
  const cancel_search_btn =
    requireElement<HTMLElement>("#cancel_search_btn")

  // Ctrl+F arrives through the keyboard dispatcher; see keyboard/commands.ts.
  getKeyboardDispatcher().register("search.focus", () => {
    searchfield.focus()
    searchfield.select()
  })

  addSiteSearchScopes(search_scope)

  searchfield.addEventListener("input", () => {
    if (search_scope.value == "local") {
      searchStories(searchfield.value)
    }
  })

  search_scope.addEventListener("change", () => {
    syncPlaceholder(searchfield, search_scope.value)
    if (searchfield.value != "") {
      searchStories(searchfield.value)
    }
  })

  // Arrow-down out of the search box and into the results, the way every
  // search field behaves. The global arrow bindings deliberately do not fire
  // while a text field has focus, so without this the list is unreachable from
  // here without the mouse.
  searchfield.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown") return
    e.preventDefault()
    getKeyboardDispatcher().run("story.cursor-next")
  })

  searchfield.addEventListener("keyup", (e) => {
    if (e.keyCode === 27) {
      //ESC
      searchfield.value = ""
      searchStories(searchfield.value)
    } else if (e.keyCode === 13) {
      //ENTER
      if (!openSiteSearch(search_scope.value, searchfield.value)) {
        searchStories(searchfield.value)
      }
    }
  })

  cancel_search_btn.onclick = () => {
    searchfield.value = ""
    searchStories("")
  }
}

const SITE_SCOPE = "site:"

/** One entry per collector with a search of its site's own, after local and global. */
function addSiteSearchScopes(search_scope: HTMLInputElement): void {
  site_search_providers().forEach((provider) => {
    const option = document.createElement("option")
    option.value = SITE_SCOPE + provider.options.id
    option.textContent = provider.site_search.label
    search_scope.append(option)
  })
  // The menu is as wide as its longest entry, and the search text has to start
  // after it; search.css reads the width from here.
  if (typeof ResizeObserver === "undefined") return
  new ResizeObserver(() => {
    const width = Math.ceil(search_scope.getBoundingClientRect().width)
    search_scope.parentElement?.style.setProperty("--search-scope-measured-size", `${width}px`)
  }).observe(search_scope)
}

let default_placeholder: string | null = null

/** A site's own search says that Enter is what leaves for the site. */
function syncPlaceholder(searchfield: HTMLInputElement, scope: string): void {
  default_placeholder ??= searchfield.placeholder
  const provider = scope.startsWith(SITE_SCOPE)
    ? site_search_providers().find((p) => SITE_SCOPE + p.options.id === scope)
    : undefined
  searchfield.placeholder = provider
    ? `Enter opens the ${provider.site_search.label} search page`
    : default_placeholder
}

/** Opens the site's search page when a site scope is selected; false otherwise. */
function openSiteSearch(scope: string, needle: string): boolean {
  if (!scope.startsWith(SITE_SCOPE)) return false
  const id = scope.substring(SITE_SCOPE.length)
  const provider = site_search_providers().find((p) => p.options.id === id)
  if (provider && needle.trim() != "") {
    getOnceClient().openUrl(provider.site_search.url(needle.trim()), "_self")
  }
  return true
}

const specialk: Record<string, () => void> = {
  "[ALL]": () => {
    const searchfield = requireElement<HTMLInputElement>("#searchfield")
    searchfield.value = ""
    searchStories("")
  },
  "[filtered]": () => {
    const story_container = requireElement<HTMLElement>("#stories")
    story_container.classList.add("show_filtered")
    searchableStoryElements(story_container).forEach((x) => {
      x.classList.remove("nomatch")
      if (!x.classList.contains("filtered")) {
        x.classList.add("nomatch")
      }
    })
  },
  "[stared]": () => {
    searchableStoryElements(requireElement("#stories")).forEach((x) => {
      x.classList.add("nomatch")
      if (x.classList.contains("stared")) {
        x.classList.remove("nomatch")
      }
    })
  },
  "[new]": () => {
    searchableStoryElements(requireElement("#stories")).forEach((x) => {
      x.classList.add("nomatch")
      if (!x.classList.contains("read")) {
        x.classList.remove("nomatch")
      }
    })
  }
}

// Built-in providers; add-ons contribute theirs through mountAddons.
const extra_search_providers: Record<
  string,
  { type: "global" | "local"; func: (needle: string) => void }
> = {
  domain: {
    type: "global",
    func: async (needle: string) => {
      const search_scope = requireElement<HTMLInputElement>("#search_scope")
      search_scope.value = "global"
      syncPlaceholder(requireElement<HTMLInputElement>("#searchfield"), search_scope.value)
      getOnceClient().searchCollectors("domain", needle).forEach((search) => {
        search.then((res: Story[]) => {
          add_global_search_results(res)
        })
      })
    }
  }
}

export async function searchStories(needle: string): Promise<void> {
  const searchfield =
    requireElement<HTMLInputElement>("#searchfield")
  const story_container = requireElement<HTMLElement>("#stories")
  const global_search_results = requireElement<HTMLElement>(
    "#global_search_results"
  )
  const cancel_search_btn =
    requireElement<HTMLElement>("#cancel_search_btn")
  const search_scope =
    requireElement<HTMLInputElement>("#search_scope")

  searchfield.value = needle
  // Other code sets the scope without a change event (the sidebar's filters).
  syncPlaceholder(searchfield, search_scope.value)

  story_container.classList.remove("show_filtered")
  story_container.classList.remove("search-hidden")
  global_search_results.classList.add("search-hidden")
  global_search_results.classList.remove("search-visible")

  if (needle && needle != "") {
    cancel_search_btn.classList.add("search-cancel-visible")
    story_container.classList.add("show_stored_star")
  } else {
    cancel_search_btn.classList.remove("search-cancel-visible")
    story_container.classList.remove("show_stored_star")
  }

  if (Object.prototype.hasOwnProperty.call(specialk, needle)) {
    specialk[needle]()
    return
  }

  const split = needle.split(":")
  if (split.length > 1) {
    const proto = split.shift() ?? ""
    needle = split.join(":")
    if (extra_search_providers[proto]) {
      const search_provider = extra_search_providers[proto]
      if (search_provider.type == "global") {
        global_search_results.classList.remove("search-hidden")
        global_search_results.classList.add("search-visible")
        story_container.classList.add("search-hidden")
        global_search_results.innerHTML = ""
      }

      extra_search_providers[proto].func(needle)
      return
    }
  }

  // A site's own search is a query for the site, not for this list, which
  // stays whole until Enter opens the site.
  if (search_scope.value.startsWith(SITE_SCOPE)) {
    story_container.classList.remove("show_stored_star")
    local_search("")
    return
  }

  if (needle != "" && search_scope.value == "global") {
    global_search_results.classList.remove("search-hidden")
    global_search_results.classList.add("search-visible")
    story_container.classList.add("search-hidden")
    global_search_results.innerHTML = ""
    getOnceClient().searchCollectors("global", needle).forEach((search) => {
      search.then((results: Story[]) => {
        add_global_search_results(results)
      })
    })

    return
  }

  local_search(needle)
}

async function local_search(needle: string) {
  searchableStoryElements<StoryListItem>(requireElement("#stories")).forEach(
    (story_el) => {
      const find_in: (string | undefined)[] = [
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
    }
  )

  StoryList.sortStories()
}

async function add_global_search_results(search_stories: Story[]) {
  const client = getOnceClient()
  const filterList = await client.getFilterList()
  const filtered_stories = applyStoryFilters(filterList, search_stories)
  const global_search_results = requireElement<HTMLElement>(
    "#global_search_results"
  )
  // Results are collector-fresh; a story the user already read, skipped or
  // starred must still show that, so look each one up in the store first.
  const stories = await Promise.all(
    filtered_stories.map(async (story) =>
      adoptStoredStoryState(story, await client.findStoryByUrl(story.href))
    )
  )
  stories.forEach((story) => {
    const href = story.href.replace(/["\\]/g, "\\$&")
    if (!global_search_results.querySelector(`.story[data-href="${href}"]`)) {
      story.bucket = "global_search_results"
      global_search_results.appendChild(new StoryListItem(story))
    }
  })
  StoryList.sortStories("global_search_results")
}
