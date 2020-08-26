const stories = require("./stories")

module.exports = {
  story_sources,
}

const default_sources = [
  "https://news.ycombinator.com/",
  "https://news.ycombinator.com/news?p=2",
  "https://news.ycombinator.com/news?p=3",
  "https://lobste.rs/",
  "https://old.reddit.com/r/netsec/.rss",
]

function story_sources() {
  let story_sources = localStorage.getItem("story_sources")
  try {
    story_sources = JSON.parse(story_sources)
  } finally {
    if (!Array.isArray(story_sources)) {
      story_sources = default_sources
    }
  }
  return story_sources
}

function set_sources_area() {
  sources_area.value = story_sources().join("\n")
}
set_sources_area()

sources_area.parentElement
  .querySelector('input[value="save"]')
  .addEventListener("click", save_sources_settings)
sources_area.parentElement
  .querySelector('input[value="cancel"]')
  .addEventListener("click", set_sources_area)

sources_area.addEventListener("keydown", (e) => {
  if (e.keyCode === 27) {
    //ESC
    set_sources_area()
  } else if ((e.key = "s" && e.ctrlKey)) {
    //CTRL + s
    save_sources_settings()
  }
})

function save_sources_settings() {
  let story_sources = sources_area.value.split("\n").filter((x) => {
    return x.trim() != ""
  })
  localStorage.setItem("story_sources", JSON.stringify(story_sources))
  stories.reload()
}

function set_filter_area() {
  filter_area.value = filters.get_filterlist().join("\n")
}
set_filter_area()

filter_area.parentElement
  .querySelector('input[value="save"]')
  .addEventListener("click", save_filter_settings)
filter_area.parentElement
  .querySelector('input[value="cancel"]')
  .addEventListener("click", set_filter_area)

filter_area.addEventListener("keydown", (e) => {
  if (e.keyCode === 27) {
    //ESC
    set_filter_area()
  } else if ((e.key = "s" && e.ctrlKey)) {
    //CTRL + s
    save_filter_settings()
  }
})

function save_filter_settings() {
  let filter_list = filter_area.value.split("\n").filter((x) => {
    return x.trim() != ""
  })
  localStorage.setItem("filterlist", JSON.stringify(filter_list))
  stories.refilter()
}
