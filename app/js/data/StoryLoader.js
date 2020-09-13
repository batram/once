const { Story } = require("./Story")
const story_map = require("./StoryMap")
const story_list = require("../view/StoryList")

module.exports = {
  load,
  parallel_load_stories,
  story_map,
  add_stored_stars,
}


function add_story(story, bucket = "stories") {
  if (!(story instanceof Story)) {
    let xstory = new Story()
    for (let i in story) {
      xstory[i] = story[i]
    }

    story = xstory
  }
  story.bucket = bucket
  story = story_map.set(story.href.toString(), story)

  //check if we already have story with same URL
  let og_story_el = document.querySelector(
    `#${bucket} .story[data-href="${story.href}"]`
  )

  if (og_story_el) {
    // merge story by adding info block, ignore title
    // don't merge on same comment_url, sometimes the same story is on multiple pages
    if (story.comment_url != og_story_el.dataset.comment_url) {
      //avoid adding the same source twice
      if (
        og_story_el.querySelector(
          '.comment_url[href="' + story.comment_url + '"]'
        ) == null
      ) {
        let add_info = info_block(story)
        og_story_el.querySelector(".data").append(add_info)
      }
    }
    return
  }

  let new_story_el = story_list.story_html(story)
  let stories_container = document.querySelector("#" + bucket)

  //hide new stories if search is active, will be matched and shown later
  if (searchfield.value != "" && bucket != "global_search_results") {
    new_story_el.classList.add("nomatch")
  }

  stories_container.appendChild(new_story_el)
}

function get_cached(url) {
  let cached = localStorage.getItem(url)
  let max_mins = 5

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

function sort_raw_stories(stories) {
  return stories.sort()
}

async function collect_all_stories(urls, try_cache = true) {
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

async function parallel_load_stories(urls, try_cache = true) {
  urls.map(async (url) => {
    cache_load(url, try_cache).then(process_story_input)
  })
}

async function process_story_input(stories) {
  let all_stories = sort_raw_stories(stories)
  all_stories.forEach((story) => {
    story_list.add_story(story)
  })

  //add all stored stared stories
  let starlist = await settings.get_starlist()
  add_stored_stars(starlist)

  story_list.sort_stories()

  if (searchfield.value != "") {
    search.search_stories(searchfield.value)
  }
}

//data loader
async function cache_load(url, try_cache = true) {
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

async function story_enhancers() {
  let enhance = await Promise.all([
    settings.get_readlist(),
    settings.get_starlist(),
  ])
  return enhance
}

async function enhance_stories(stories) {
  let enhance = await story_enhancers()
  let filtered_stories = await filters.filter_stories(stories)
  let readlist = enhance[0]
  let starlist = enhance[0]

  return filtered_stories.map((story) => {
    story = story_map.set(story.href.toString(), story)
    story.read = readlist.includes(story.href)
    if (starlist.hasOwnProperty(story.href)) {
      story.stared = starlist.hasOwnProperty(story.href)
    }
    return story
  })
}

async function parse_story_response(val, url) {
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

async function load(urls) {
  let cache = false
  parallel_load_stories(urls, cache)
}

function add_stored_stars(starlist) {
  for (let href in starlist) {
    if (!story_loader.story_map.has(href.toString())) {
      let star_story = starlist[href]
      star_story.stared = true
      star_story.stored_star = true
      add_story(star_story)
    }
  }
}
