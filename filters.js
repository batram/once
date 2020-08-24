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
  } finally {
    if (!Array.isArray(filterlist)) {
      filterlist = []
    }
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

function show_filter_dialog(event, filter_btn, story) {
  event.stopPropagation()
  event.preventDefault()

  let inp = filter_btn.querySelector("input")

  //cancel other open inputs
  document.querySelectorAll(".story:not(.filtered) .filter_btn input").forEach((x) => {
    if (inp != x) {
      x.outerHTML = ""
    }
  })

  if (inp) {
    if(event.target != inp){
      confirm_add_story(inp, filter_btn)
    }
    return
  }

  document.addEventListener("click", (e) => {
    if (e.target != filter_btn) {
      document.querySelectorAll(".story:not(.filtered) .filter_btn input").forEach((x) => {
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
    //TODO: no full reload, just filter local stories
    stories.reload()
  }
}

