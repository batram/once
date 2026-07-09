export const options = {
  type: "tw",
  description:
    "Collect tweets from a specific Twitter user (https://nitter.net/) by parsing HTML",
  pattern: "https://nitter.net/",
  collects: "dom",
  colors: ["rgba(29, 161, 242, 0.56)", "white"],
  settings: {
    filter_ads: {
      value: true,
      description: "Filter advertising tweets without likes or retweets",
    },
  },
}

const user_url = "https://nitter.net/"

import { Story } from "../../data/Story"

export function parse(doc: Document): Story[] {
  const stories = Array.from(doc.querySelectorAll(".timeline-item"))

  return stories.map((story_el: HTMLElement) => {
    const story_link =
      story_el.querySelector<HTMLAnchorElement>(".tweet-date a")

    const time = story_link.getAttribute("title").replace("·", "")
    const timestamp = Date.parse(time)

    const user_id = story_el
      .querySelector<HTMLAnchorElement>(".tweet-avatar")
      .href.substring(1)

    const story_text =
      story_el.querySelector<HTMLDivElement>(".tweet-content").innerText

    //filter ads
    let filter = null
    if (options.settings.filter_ads.value) {
      if (story_el.querySelector(".ProfileTweet-actionCountList") != null) {
        filter = ":: Twitter ads ::"
      }
    }

    const new_story = new Story(
      options.type,
      story_link.href,
      story_text,
      user_url + user_id,
      timestamp,
      filter
    )

    const user_el = story_el.querySelector<HTMLAnchorElement>(".username")
    if (user_el) {
      const user_id =
        story_el.querySelector<HTMLAnchorElement>(".username").innerText

      const user_tag = {
        class: "user",
        text: user_id,
        href: user_url + user_id,
      }
      new_story.tags.push(user_tag)
    }

    return new_story
  })
}
