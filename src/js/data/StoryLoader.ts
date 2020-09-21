import * as story_parser from "../data/parser"
import { StoryMap } from "../data/StoryMap"
import { Story } from "./Story"
import { OnceSettings } from "../OnceSettings"
import * as search from "../data/search"
import * as story_filters from "./StoryFilters"
import * as story_list from "../view/StoryList"

export { load, parallel_load_stories, add_stored_stars, enhance_stories }

function get_cached(url: string) {
  let cached = localStorage.getItem(url)
  let max_mins = 5000

  try {
    cached = JSON.parse(cached)
    if (!Array.isArray(cached)) {
      throw "cached entry is not Array"
    }
    if (cached.length != 2) {
      throw "cached entry not length 2"
    }
    let mins_old = (Date.now() - cached[0]) / (60 * 1000)
    if (mins_old > max_mins) {
      throw "cached entry out of date " + mins_old
    } else {
      console.log("cached", mins_old, url)
    }
  } catch (e) {
    console.log("cache error: ", e)
    return null
  }

  return cached[1]
}

function sort_raw_stories(raw_stories: any[]): Story[] {
  if (raw_stories) {
    return raw_stories.sort()
  } else {
    return []
  }
}

async function collect_all_stories(urls: string[], try_cache: boolean = true) {
  let donso = await Promise.all(
    urls.map(async (url) => {
      return cache_load(url, try_cache)
    })
  )

  process_story_input(
    donso
      .filter((x) => {
        return x != undefined
      })
      .flat()
  )
}

async function parallel_load_stories(urls: string[], try_cache = true) {
  urls.map(async (url) => {
    cache_load(url, try_cache).then(process_story_input)
  })
}

async function process_story_input(stories: Story[]) {
  stories = await enhance_stories(stories)

  let all_stories = sort_raw_stories(stories)
  all_stories.forEach((story) => {
    StoryMap.instance.add(story)
  })

  //add all stored stared stories
  let starlist = await OnceSettings.instance.get_starlist()
  add_stored_stars(starlist)

  story_list.sort_stories()
  let searchfield = document.querySelector<HTMLInputElement>("#searchfield")
  if (searchfield.value != "") {
    search.search_stories(searchfield.value)
  }
}

//data loader
async function cache_load(url: string, try_cache: boolean = true) {
  let cached = null
  if (try_cache) {
    //TODO: do we need to store the type?
    cached = get_cached(url)
  }

  if (cached != null) {
    let parser = story_parser.get_parser_for_url(url)
    if (parser.options.collects == "dom") {
      cached = story_parser.parse_dom(cached, url)
    }
    return parser.parse(cached)
  } else {
    let resp = await fetch(url)
    if (resp.ok) {
      return story_parser.parse_response(resp, url)
    }
  }
}

async function enhance_stories(stories: Story[], add: boolean = true) {
  let filtered_stories = await story_filters.filter_stories(stories)
  let readlist = await OnceSettings.instance.get_readlist()
  let starlist = await OnceSettings.instance.get_starlist()

  return filtered_stories.map((story: Story) => {
    if (add) {
      story = StoryMap.instance.add(story)
    }
    story.read = readlist.includes(story.href)
    if (starlist.hasOwnProperty(story.href)) {
      story.stared = starlist.hasOwnProperty(story.href)
    }
    return story
  })
}

async function load(urls: string[]) {
  let cache = false
  parallel_load_stories(urls, cache)
}

interface Starlist {
  [index: string]: Story | { stared: boolean; stored_star: boolean }
}

//TODO: specify starlist format
function add_stored_stars(starlist: Starlist) {
  for (let href in starlist) {
    let star_story = Story.from_obj(starlist[href])
    star_story.stared = true
    star_story.stored_star = true
    StoryMap.instance.add(star_story)
  }
}
