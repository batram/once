const settings = require("./settings")

module.exports = {
  filter_story,
  add_filter,
  show_filter_dialog,
  filter_stories,
  get_filterlist,
}

let dynamic_filters = {
  "twitter.com": twitnit,
  "www.reddit.com": old_reddit,
}

function get_filterlist() {
  return settings.get_filterlist()
}

function twitnit(story) {
  story.href = story.href.replace("twitter.com", "nitter.net")
  return story
}

function old_reddit(story) {
  story.href = story.href.replace("www.reddit.com", "old.reddit.com")
  return story
}

function add_filter(filter) {
  get_filterlist().then((filter_list) => {
    filter_list.push(filter.toString())
    settings.save_filterlist(filter_list)
  })
}

async function filter_stories(stories) {
  let flist = get_filterlist()
  const filter_list = await get_filterlist()
  return stories.map((story) => {
    return filter_run(filter_list, story)
  })
}

async function filter_story(story) {
  return get_filterlist().then((filter_list) => {
    return filter_run(filter_list, story)
  })
}

function filter_run(filter_list, story) {
  for (pattern in filter_list) {
    if (
      story.href.includes(filter_list[pattern]) ||
      story.title
        .toLocaleLowerCase()
        .includes(filter_list[pattern].toLocaleLowerCase())
    ) {
      story.filter = filter_list[pattern]
      return story
    }
  }

  for (pattern in dynamic_filters) {
    if (story.href.includes(pattern)) {
      return dynamic_filters[pattern](story)
    }
  }

  return story
}

function show_filter_dialog(event, filter_btn, story) {
  event.stopPropagation()
  event.preventDefault()

  let inp = filter_btn.querySelector("input")

  //cancel other open inputs
  document
    .querySelectorAll(".story:not(.filtered) .filter_btn input")
    .forEach((x) => {
      if (inp != x) {
        x.outerHTML = ""
      }
    })

  if (inp) {
    if (event.target != inp) {
      confirm_add_story(inp, filter_btn)
    }
    return
  }

  document.addEventListener("click", (e) => {
    if (e.target != filter_btn) {
      document
        .querySelectorAll(".story:not(.filtered) .filter_btn input")
        .forEach((x) => {
          x.outerHTML = ""
        })
    }
  })

  inp = document.createElement("input")
  inp.type = "text"
  inp.value = story.hostname
  filter_btn.prepend(inp)
  inp.focus()
  inp.addEventListener("keyup", (e) => {
    if (e.keyCode === 27) {
      //ESC
      event.target.innerText = "filter"
    } else if (e.keyCode === 13) {
      //ENTER
      confirm_add_story(inp, filter_btn)
    }
  })
}

function confirm_add_story(inp, filter_btn) {
  if (confirm('add filter: "' + inp.value + '"')) {
    filters.add_filter(inp.value)
    filter_btn.querySelectorAll(".filter_btn input").outerHTML = ""
  }
}
