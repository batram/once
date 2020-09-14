const onChange = require("on-change")
const { Story } = require("./Story")

let s_map = {}

const story_map = onChange(s_map, function (path, value, previousValue, name) {
  //console.log("data_change", path, value, previousValue, name)
  if (path.length != 0) {
    if (typeof this[path[0]] == "object") {
      if (name && this[path[0]] instanceof Story) {
        //console.log("story change", name)
      }

      const event = new CustomEvent("data_change", {
        detail: {
          story: story_map.get(path[0]),
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
})

story_map.set = (x, y) => {
  story_map[x] = y
  return story_map[x]
}

story_map.get = (x) => {
  return story_map[x]
}

story_map.has = (x) => {
  return story_map.hasOwnProperty(x)
}

story_map.clear = () => {
  for (let i in story_map) {
    if (typeof story_map[i] != "function") {
      delete story_map[i]
    }
  }
}

function update_story(href, path, value) {
  let story = story_map.get(href)
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

function add(story, bucket = "stories") {
  if (!(story instanceof Story)) {
    let xstory = new Story()
    for (let i in story) {
      xstory[i] = story[i]
    }

    story = xstory
  }
  story.bucket = bucket

  let og_story = story_map.get(story.href)
  if (!og_story) {
    //new story
    story = story_map.set(story.href.toString(), story)
    require("../view/StoryList").add(story, bucket)
  } else {
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

module.exports = {
  set: story_map.set,
  get: story_map.get,
  has: story_map.has,
  clear: story_map.clear,
  update_story,
  add,
}
