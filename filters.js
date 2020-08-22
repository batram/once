module.exports = {
  filter_story,
  add_filter,
  show_filter_dialog,
}

let default_filterlist = `bbc.co.uk
bbc.com
bloomberg.com
brave.com
buzzfeed.com
cnbc.com
cnn.com
dw.com
forbes.com
fortune.com
foxnews.com
hbr.org
latimes.com
mercurynews.com
mozilla.org
newyorker.com
npr.org
nytimes.com
rarehistoricalphotos.com
reuters.com
sfchronicle.com
sfgate.com
slate.com
techcrunch.com
theatlantic.com
thedailybeast.com
thedrive.com
theguardian.com
thetimes.co.uk
theverge.com
vice.com
vox.com
washingtonpost.com
wired.com
wsj.com
yahoo.com`
  .split("\n")
  .map((x) => x.trim())

let dynamic_filters = {
  "twitter.com": twitnit,
  "www.reddit.com": old_reddit,
}

function get_filterlist() {
  if (!localStorage.hasOwnProperty("filterlist")) {
    localStorage.setItem("filterlist", JSON.stringify(default_filterlist))
    return default_filterlist
  }

  let filterlist = localStorage.getItem("filterlist")
  try {
    filterlist = JSON.parse(filterlist)
  } catch (e) {
    filterlist = []
  }

  return filterlist
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
  let filter_list = get_filterlist()
  filter_list.push(filter.toString())
  localStorage.setItem("filterlist", JSON.stringify(filter_list))
}

function filter_story(story) {
  let filter_list = get_filterlist()
  for (pattern in filter_list) {
    if (
      story.href.includes(filter_list[pattern]) ||
      story.title
        .toLocaleLowerCase()
        .includes(filter_list[pattern].toLocaleLowerCase())
    ) {
      story.filtered = true
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

function show_filter_dialog(event, story) {
  event.stopPropagation()
  event.preventDefault()

  if (event.target.childElementCount != 0) {
    return
  }

  document.addEventListener("click", (e) => {
    if (e.target != event.target) {
      document.querySelectorAll(".filter_btn").forEach((x) => {
        if (!x.innerText.includes("filtered:")) {
          x.innerText = "filter"
        }
      })
    }
  })

  let inp = document.createElement("input")
  inp.type = "text"
  inp.value = story.hostname
  event.target.appendChild(inp)
  inp.focus()
  inp.addEventListener("keyup", (e) => {
    if (e.keyCode === 27) {
      //ESC
      event.target.innerText = "filter"
    } else if (e.keyCode === 13) {
      //ENTER
      if (confirm('add filter: "' + inp.value + '"')) {
        filters.add_filter(inp.value)
        event.target.innerText = "filter"
      }
    }
  })
}
