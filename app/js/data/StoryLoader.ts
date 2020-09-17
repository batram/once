const story_map = require("./StoryMap")
const story_parser = require("./parser")
import * as filters from "../data/filters"
import { Story } from "./Story"
import * as settings from "../settings"
import * as search from "../data/search"
import * as story_filters from "../data/filters"

export {
  load,
  parallel_load_stories,
  story_map,
  add_stored_stars,
  enhance_stories,
}

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
  let all_stories = sort_raw_stories(stories)
  all_stories.forEach((story) => {
    story_map.add(story)
  })

  //add all stored stared stories
  let starlist = await settings.get_starlist()
  add_stored_stars(starlist)

  require("../view/StoryList").sort_stories()
  let searchfield = document.querySelector<HTMLInputElement>("#searchfield")
  if (searchfield.value != "") {
    search.search_stories(searchfield.value)
  }
}

//data loader
async function cache_load(url: string, try_cache: boolean = true) {
  let cached = null
  if (try_cache) {
    cached = get_cached(url)
  }
  if (cached != null) {
    return parse_story_response(cached, url)
  } else {
    return fetch(url).then((x) => {
      if (x.ok) {
        return x.text().then((val) => {
          localStorage.setItem(url, JSON.stringify([Date.now(), val]))
          return parse_story_response(val, url)
        })
      }
    })
  }
}

async function enhance_stories(stories: Story[], add: boolean = true) {
  let filtered_stories = await story_filters.filter_stories(stories)
  let readlist = await settings.get_readlist()
  let starlist = await settings.get_starlist()

  return filtered_stories.map((story: Story) => {
    if (add) {
      story = story_map.add(story)
    }
    story.read = readlist.includes(story.href)
    if (starlist.hasOwnProperty(story.href)) {
      story.stared = starlist.hasOwnProperty(story.href)
    }
    return story
  })
}

async function parse_story_response(val: string, url: string) {
  let dom_parser = new DOMParser()
  let doc = dom_parser.parseFromString(val, "text/html")

  if (!doc.querySelector("base")) {
    let base = document.createElement("base")
    base.href = url
    doc.head.append(base)
  } else {
    console.log("base already there", doc.querySelector("base"))
  }

  let stories = story_parser.parse(url, doc)
  return enhance_stories(stories)
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
    let star_story = starlist[href]
    star_story.stared = true
    star_story.stored_star = true
    story_map.add(star_story)
  }
}
