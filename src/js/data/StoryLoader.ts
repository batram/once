import * as story_parser from "../data/parser"
import { StoryMap } from "../data/StoryMap"
import { Story } from "./Story"
import * as story_filters from "./StoryFilters"

export { load, parallel_load_stories }

function get_cached(url: string) {
  let cached = localStorage.getItem(url)
  const max_mins = 5000

  try {
    cached = JSON.parse(cached)
    if (!Array.isArray(cached)) {
      throw "cached entry is not Array"
    }
    if (cached.length != 2) {
      throw "cached entry not length 2"
    }
    const mins_old = (Date.now() - cached[0]) / (60 * 1000)
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

async function parallel_load_stories(
  urls: string[],
  try_cache = true
): Promise<void> {
  urls.map(async (url) => {
    cache_load(url, try_cache).then(process_story_input)
  })
}

async function process_story_input(stories: Story[]) {
  if (!stories) {
    return
  }
  const filtered_stories = await story_filters.filter_stories(stories)
  const all_stories = filtered_stories.sort()
  StoryMap.remote.stories_loaded(all_stories, "stories")
}

//data loader
async function cache_load(url: string, try_cache = true) {
  let cached = null
  if (try_cache) {
    //TODO: do we need to store the type?
    cached = get_cached(url)
  }

  if (cached != null) {
    const parser = story_parser.get_parser_for_url(url)
    if (parser.options.collects == "dom") {
      cached = story_parser.parse_dom(cached, url)
    } else if (parser.options.collects == "xml") {
      cached = story_parser.parse_xml(cached)
    }
    return parser.parse(cached) || []
  } else {
    const resp = await fetch(url)
    if (resp.ok) {
      return story_parser.parse_response(resp, url) || []
    }
  }
}

async function load(urls: string[]): Promise<void> {
  const cache = false
  parallel_load_stories(urls, cache)
}
