const { Story } = require("../data/Story")
const { get_starlist, story_sources } = require("../settings")
const filters = require("../data/filters")
const story_item = require("../view/StoryListItem")
const { story_map } = require("../data/StoryLoader")

module.exports = {
  mark_selected,
  reload,
  refilter,
  restar,
  sort_stories,
  resort_single,
  add,
  story_html: story_item.story_html,
}

function add(story, bucket = "stories") {
  if (!(story instanceof Story)) {
    story = Story.from_obj(story)
    story = story_loader.story_map.set(story.href.toString(), story)
  }

  story.bucket = bucket

  let new_story_el = story_item.story_html(story)
  let stories_container = document.querySelector("#" + bucket)

  //hide new stories if search is active, will be matched and shown later
  if (searchfield.value != "" && bucket != "global_search_results") {
    new_story_el.classList.add("nomatch")
  }

  stories_container.appendChild(new_story_el)
}

function mark_selected(story_el, url) {
  if (!story_el && url) {
    let info_can = document.querySelector(`.story a[href="${url}"]`)
    if (info_can) {
      let parent = info_can.parentElement
      let max = 5
      while (!parent.classList.contains("story") && max > 0) {
        max -= 1
        parent = parent.parentElement

        if (parent.classList.contains("story")) {
          story_el = parent
          break
        }
      }
    }
  }

  document.querySelectorAll(".story").forEach((x) => {
    if (x.classList.contains("selected")) {
      x.classList.remove("selected")
      let fun = resort_single(x)
      if (typeof fun == "function") {
        fun()
      }
    }
  })

  if (story_el) {
    story_el.classList.add("selected")
    let og_story = story_loader.story_map.get(story_el.dataset.href)
    if (og_story.href == url) {
      og_story.mark_as_read()
    }
    return og_story
  } else {
    return null
  }
}

function story_compare(a, b) {
  //sort by read first and then timestamp
  if (a.read && !b.read) {
    return 1
  } else if (!a.read && b.read) {
    return -1
  } else if ((a.read && b.read) || (!a.read && !b.read)) {
    if (a.timestamp > b.timestamp) return -1
    if (a.timestamp < b.timestamp) return 1
    return 0
  }
  if (a.timestamp > b.timestamp) return -1
  if (a.timestamp < b.timestamp) return 1
  return 0
}

function sortable_story(elem) {
  return {
    read: elem.classList.contains("read"),
    timestamp: elem.dataset.timestamp,
    el: elem,
  }
}

function resort_single(elem) {
  let story_con = elem.parentElement
  let stories = Array.from(story_con.querySelectorAll(".story")).filter(
    (el) => {
      return (
        getComputedStyle(el).display != "none" &&
        !el.classList.contains("selected")
      )
    }
  )

  let stories_sorted = stories
    .map(sortable_story)
    .sort(story_compare)
    .map((x) => x.el)

  let insert_before_el = false
  let sorted_pos = stories_sorted.indexOf(elem)

  if (stories.indexOf(elem) == sorted_pos) {
    //don't need to resort, would keep our position
    return false
  } else if (sorted_pos != stories_sorted.length - 1) {
    insert_before_el = stories_sorted[sorted_pos + 1]
  }

  return (x) => {
    if (!insert_before_el) {
      story_con.appendChild(elem)
    } else {
      story_con.insertBefore(elem, insert_before_el)
    }

    if (elem.classList.contains("read_anim")) {
      setTimeout((t) => {
        elem.classList.remove("read_anim")
      }, 1)
    }
    if (elem.classList.contains("unread_anim")) {
      setTimeout((t) => {
        elem.classList.remove("unread_anim")
      }, 1)
    }
  }
}

function sort_stories(bucket = "stories") {
  let story_con = document.querySelector("#" + bucket)

  let storted = Array.from(story_con.querySelectorAll(".story"))
    .map(sortable_story)
    .sort(story_compare)

  storted.forEach((x) => {
    let paw = x.el.parentElement
    paw.appendChild(x.el)
    if (x.el.classList.contains("read_anim")) {
      setTimeout((t) => {
        x.el.classList.remove("read_anim")
      }, 1)
    }
    if (x.el.classList.contains("unread_anim")) {
      setTimeout((t) => {
        x.el.classList.remove("unread_anim")
      }, 1)
    }
  })
}

async function restar() {
  let starlist = await get_starlist()
  document.querySelectorAll(".story").forEach((story_el) => {
    let sthref = story_el.dataset.href
    let story = story_loader.story_map.get(sthref.toString())
    story.stared = starlist.hasOwnProperty(sthref)
  })

  story_loader.add_stored_stars(starrlist)
}

function refilter() {
  document.querySelectorAll(".story").forEach((x) => {
    let sthref = x.dataset.href.toString()
    let story = story_loader.story_map.get(sthref.toString())
    let og_filter = story.filter
    filters.filter_story(story).then((story) => {
      if (story.filter != og_filter) {
        let nstory = story_item.story_html(
          story_loader.story_map.get(sthref.toString())
        )
        x.replaceWith(nstory)
      }
    })
  })
}

function reload() {
  //dont remove the selected story on reload
  let selected = null
  if (document.querySelector(".selected")) {
    let href = document.querySelector(".selected").dataset.href
    let story = story_loader.story_map.get(href).clone()
    story_loader.story_map.clear()
    story_map.set(href, story)
  } else {
    story_loader.story_map.clear()
  }

  document.querySelectorAll(".story").forEach((x) => {
    if (!x.classList.contains("selected")) {
      x.outerHTML = ""
    }
  })

  story_sources().then(story_loader.load)
}

if (document.querySelector("#reload_stories_btn")) {
  reload_stories_btn.onclick = reload
}
