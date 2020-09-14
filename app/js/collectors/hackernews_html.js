const options = {
  tag: "HN",
  description:
    "Collect stories from HackerNews (https://news.ycombinator.com/) by parsing HTML",
  pattern: "https://news.ycombinator.com/",
  colors: ["rgba(255, 102, 0, 0.56)", "white"],
  settings: {
    filter_ads: {
      value: true,
      description: "Filter advertising for job oppenings without comments",
    },
  },
}

module.exports = {
  parse,
  options,
}

const { Story } = require("../data/Story")
const { parse_human_time } = require("../data/parser")

function parse(doc, type) {
  let curl = "https://news.ycombinator.com/item?id="
  let stories = Array.from(doc.querySelectorAll(".storylink"))

  return stories.map((story_el) => {
    let pawpaw = story_el.parentElement.parentElement
    let id = pawpaw.id
    if (story_el.protocol == "file:") {
      story_el.href = curl + id
    }

    let time = pawpaw.nextElementSibling.querySelector(".age a").innerText
    let timestamp = parse_human_time(time)

    //filter ads
    let filter = null
    if (options.settings.filter_ads.value) {
      if (
        story_el.parentElement.parentElement.querySelector(".votelinks") == null
      ) {
        filter = ":: HN ads ::"
      }
    }

    return new Story(
      type,
      story_el.href,
      story_el.innerText,
      curl + id,
      timestamp,
      filter
    )
  })
}
