import { Story } from "../data/Story"
import * as onChange from "on-change"
import * as story_list from "../view/StoryList"

export { story_map, update_story, add, set, has, clear, get }

let s_map = {}

const story_map: Record<string, Story> = onChange(s_map, on_update, {
  pathAsArray: true,
})

function on_update(
  path: string,
  value: unknown,
  previousValue: unknown,
  name: string
) {
  console.debug("data_change", path, value, previousValue, name)
  if (path.length != 0) {
    if (typeof has(path[0])) {
      const event = new CustomEvent("data_change", {
        detail: {
          story: get(path[0]),
          path: path,
          value: value,
          previousValue: previousValue,
          name: name,
        },
      })
      let story_els = document.querySelectorAll(
        `.story[data-href="${path[0]}"]`
      )
      story_els.forEach((story_el) => {
        story_el.dispatchEvent(event)
      })
      document.body.dispatchEvent(event)
    }
  }
}
function set(href: string, y: Story) {
  story_map[href] = y
  return story_map[href]
}

function get(href: string) {
  return story_map[href]
}

function has(href: string) {
  return story_map.hasOwnProperty(href)
}

function clear() {
  for (let i in story_map) {
    if (typeof story_map[i] != "function") {
      delete story_map[i]
    }
  }
}

function update_story(href: string, path: string, value: Story | string) {
  let story = get(href)
  if (path == "story" && value instanceof Story) {
    story = value
  } else {
    if (path == "read") {
      if (value) {
        story.add_to_readlist()
      } else {
        story.remove_from_readlist()
      }
    }
    if (path == "stared") {
      if (value) {
        story.star()
      } else {
        story.unstar()
      }
    }
    story[path] = value
  }
}

function add(story: Story, bucket = "stories") {
  if (!(story instanceof Story)) {
    console.log("wrong StoryMap enty", story)
    throw "Please, only put stories in the StoryMap"
  }
  /*
  if (!(story instanceof Story)) {
    let xstory = new Story()
    for (let i in story) {
      xstory[i] = story[i]
    }

    story = xstory
  }*/
  story.bucket = bucket

  let og_story = get(story.href)
  if (!og_story) {
    //new story
    story = set(story.href.toString(), story)
    story_list.add(story, bucket)
  } else {
    if (og_story.stared != story.stared) {
      story.update_stared()
    }
    if (og_story.read != story.read) {
      story.update_read()
    }

    //check if we already have as alternate source
    let curls = og_story.sources.map((x) => {
      return x.comment_url
    })

    if (!curls.includes(story.comment_url)) {
      //duplicate story
      og_story.sources.push({
        type: story.type,
        comment_url: story.comment_url,
        timestamp: story.timestamp,
      })
    }

    story = og_story
  }

  return story
}
