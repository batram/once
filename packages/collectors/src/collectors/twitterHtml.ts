export const options = {
  id: "nitter",
  type: "tw",
  description: "HTML tweets by user (via nitter.net)",
  pattern: "https://nitter.net/",
  collects: "dom",
  colors: ["rgba(29, 161, 242, 0.56)", "white"],
  settings: {
    filter_ads: {
      value: true,
      description: "Filter advertising tweets without likes or retweets"
    }
  }
}

const user_url = "https://nitter.net/"

import { Story } from "@once/core"

export function parse(doc: Document): Story[] {
  const stories = Array.from(doc.querySelectorAll<HTMLElement>(".timeline-item"))

  return stories.flatMap((story_el) => {
    const story_link = story_el.querySelector<HTMLAnchorElement>(".tweet-date a")

    if (!story_link) {
      return []
    }

    const time = (story_link.getAttribute("title") ?? "").replace("·", "")
    const timestamp = Date.parse(time)
    if (!time || !Number.isFinite(timestamp)) {
      return []
    }

    const user_id =
      story_el.querySelector<HTMLAnchorElement>(".tweet-avatar")?.href.substring(1) ?? ""

    const story_text = story_el.querySelector<HTMLDivElement>(".tweet-content")?.innerText ?? ""
    if (!story_link.href || !story_text) {
      return []
    }

    //filter ads
    let filter = ""
    if (options.settings.filter_ads.value) {
      if (story_el.querySelector(".ProfileTweet-actionCountList") != null) {
        filter = ":: Twitter ads ::"
      }
    }

    const new_story = new Story(
      options.type,
      story_link.href,
      story_text,
      user_id ? user_url + user_id : "",
      timestamp,
      filter
    )

    const user_el = story_el.querySelector<HTMLAnchorElement>(".username")
    if (user_el) {
      const user_tag = {
        class: "user",
        text: user_el.innerText,
        href: user_url + user_el.innerText
      }
      new_story.tags.push(user_tag)
    }

    return [new_story]
  })
}
