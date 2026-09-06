import { positionStoryButtons } from "./storyButtonPreferences"
import { humanTime, SubStory } from "@once/core"
import { getOnceClient } from "../client"
import { bindLinkBehavior, openStoryUrl } from "./storyLinks"
import type { StoryListItem } from "./StoryListItem"

/**
 * The per-source lines under a story title.
 *
 * A story can be posted to several aggregators; each one contributes its own
 * type badge, comments link, timestamp, and tags. The row's own source is
 * rendered as the first of them, so the markup is the same either way.
 */

function tagElement(tag: NonNullable<SubStory["tags"]>[number]): HTMLElement {
  const tag_el = document.createElement("a")
  tag_el.classList.add("tag")
  tag_el.classList.add("tag_" + tag.class)
  tag_el.innerText = tag.text

  if (tag.href) {
    const tag_href = tag.href
    tag_el.href = tag_href
    bindLinkBehavior(tag_el, {
      onClick: () => {
        getOnceClient().openUrl(tag_href, "_self")
      },
      onMiddleClick: () => {
        getOnceClient().openUrl(tag_href, "middle")
      }
    })
  }

  if (tag.icon) {
    tag_el.classList.add("tag--icon")
    tag_el.style.setProperty("--tag-icon", `url(${tag.icon})`)
  }

  return tag_el
}

/** One source line: type badge, comments link, time, tags. */
function buildInfoBlock(
  row: StoryListItem,
  sub_story_ob: SubStory
): HTMLElement {
  const info = document.createElement("div")
  info.classList.add("info")
  info.dataset.type = "[" + sub_story_ob.type + "]"
  const type = document.createElement("p")
  type.classList.add("type")
  type.innerText = sub_story_ob.type
  info.appendChild(type)

  //comments
  const comments_link = document.createElement("a")
  comments_link.classList.add("comment_url")
  comments_link.innerText = " [comments] "
  comments_link.href = sub_story_ob.comment_url || row.story.href
  info.appendChild(comments_link)

  const commentsUrl = sub_story_ob.comment_url || row.story.href
  bindLinkBehavior(comments_link, {
    onClick: () => {
      // The row's own comments go through the reading surface; a different
      // aggregator's just open.
      if (commentsUrl === row.story.comment_url) {
        row.openComments()
      } else {
        row.read_btn.classList.add("user_interaction")
        openStoryUrl(commentsUrl, "_self", false)
      }
    },
    onMiddleClick: () => {
      row.read_btn.classList.add("user_interaction")
      openStoryUrl(commentsUrl, "middle", false)
    }
  })

  const time = document.createElement("div")
  time.innerText = humanTime(sub_story_ob.timestamp)
  try {
    time.title = new Date(
      parseInt(sub_story_ob.timestamp.toString())
    ).toISOString()
  } catch (e) {
    console.log("date parsing error", sub_story_ob)
  }
  time.classList.add("time")
  info.appendChild(time)

  const tags_container = document.createElement("div")
  tags_container.classList.add("tags_container")
  if (sub_story_ob.tags) {
    sub_story_ob.tags.forEach((tag) => {
      tags_container.append(tagElement(tag))
    })
  }
  info.appendChild(tags_container)

  return info
}

/** Rebuilds the substory list in place, own source first. */
export function renderSubstories(row: StoryListItem): void {
  // Preserve live controls and their listeners while rebuilding source tags.
  if (row.button_group && row.substories_el.contains(row.button_group)) row.appendChild(row.button_group)
  row.substories_el.innerHTML = ""

  const subs = [
    {
      type: row.story.type,
      comment_url: row.story.comment_url,
      timestamp: row.story.timestamp,
      tags: row.story.tags
    },
    ...row.story.substories.filter((sub) => {
      return sub.comment_url != row.story.comment_url && sub.timestamp
    })
  ]

  subs.forEach((x: SubStory) => {
    row.substories_el.append(buildInfoBlock(row, x))
  })
  positionStoryButtons(row)
}
