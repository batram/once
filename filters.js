module.exports = {
  filter_story,
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

function filter_story(story) {
  let filter_list = get_filterlist()
  for (pattern in filter_list) {
    if (story.href.includes(filter_list[pattern])) {
      return false
    }
  }

  for (pattern in dynamic_filters) {
    if (story.href.includes(pattern)) {
      return dynamic_filters[pattern](story)
    }
  }

  return story
}
