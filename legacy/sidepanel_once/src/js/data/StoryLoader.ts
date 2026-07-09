import * as story_parser from "../data/parser"
import { StoryMap } from "../data/StoryMap"
import * as menu from "../view/menu"
import { LoaderCache } from "./LoaderCache"
import { Story } from "./Story"
import * as story_filters from "./StoryFilters"

export async function parallel_load_stories(
  story_groups: Record<string, string[]>,
  try_cache = true
): Promise<void> {
  for (const group_name in story_groups) {
    menu.add_group(group_name)
    const group = story_groups[group_name]
    group.map(async (source_entry) => {
      cache_load(source_entry, try_cache).then((stories) => {
        process_story_input(stories, group_name)
      })
    })
  }
}

async function process_story_input(stories: Story[], group_name: string) {
  if (!stories) {
    return
  }
  const filtered_stories = await story_filters.filter_stories(stories)
  const all_stories = filtered_stories.sort()
  all_stories.forEach((story) => {
    story.tags.push({
      class: "group",
      text: "*" + group_name,
      href: "search:" + "*" + group_name,
    })
  })
  StoryMap.instance.stories_loaded(all_stories, "stories")
}

//data loader
async function cache_load(url: string, try_cache = true) {
  let cachedstr = null

  const parser = story_parser.get_parser_for_url(url)
  if (!parser) {
    console.info("no parser for", url)
    return
  }

  if (try_cache) {
    cachedstr = (await LoaderCache.get_cached(url).catch((error) =>
      console.log(error)
    )) as string
  }

  const og_url = url

  if (parser && parser.resolve_url) {
    url = parser.resolve_url(url)
  }

  const delay = (time: number) => {
    return new Promise((res) => {
      setTimeout(res, time)
    })
  }

  if (cachedstr != null) {
    let parsed_cache

    switch (parser.options.collects) {
      case "json":
        parsed_cache = JSON.parse(cachedstr)
        break
      case "dom":
        parsed_cache = story_parser.parse_dom(cachedstr, url)
        break
      case "xml":
        parsed_cache = story_parser.parse_xml(cachedstr)
        break
    }
    return parser.parse(parsed_cache, url, og_url) || []
  } else {
    if (parser.options.settings.delay) {
      var delay_time =
        100 + (parser.options.settings.delay as number) * Math.random()
      console.log("url", url, "delay_time: ", delay_time)
      await delay(delay_time)
    }

    const resp = await fetch(url)
    if (resp.ok) {
      return story_parser.parse_response(resp, url, og_url) || []
    }
  }
}

export async function load(
  story_groups: Record<string, string[]>
): Promise<void> {
  const cache = false
  parallel_load_stories(story_groups, cache)
}
