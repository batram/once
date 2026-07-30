import { getOnceClient } from "../client"
import { requestReading } from "../ReadingSession"
import { SettingsPanel } from "../settings/SettingsPanel"
import { bindLinkBehavior, open_story, openStoryUrl } from "./storyLinks"
import * as StorySearch from "./storySearch"
import type { StoryListItem } from "./StoryListItem"

/**
 * The static parts of a story row.
 *
 * Everything here builds elements and wires their own listeners; nothing holds
 * state. The row keeps the pieces it later mutates (`link`, `filter_btn`) and
 * composes them in `story_html`.
 */

/**
 * The row's shared button shape. Presenters build their own buttons with it,
 * so a collector-specific action looks like the built-in ones.
 */
export function createIconButton(
  title: string,
  classname: string,
  icon_src?: string
): HTMLElement {
  const btn = document.createElement("div")
  btn.classList.add("btn")
  btn.classList.add(classname)
  btn.setAttribute("draggable", "false")
  if (icon_src) {
    const icon = document.createElement("img")
    icon.setAttribute("draggable", "false")
    icon.src = icon_src
    btn.appendChild(icon)
  }
  btn.title = title
  return btn
}

/**
 * Title, the original link, and the domain search link.
 *
 * @returns the title anchor, which the row keeps as `link`
 */
export function buildTitleLine(
  row: StoryListItem,
  container: HTMLElement,
  redirected_url: string
): HTMLAnchorElement {
  const link = document.createElement("a")
  link.href = redirected_url
  link.classList.add("title")
  link.dataset.testid = "story-title"
  link.innerText = row.story.title
  bindLinkBehavior(link, {
    onClick: () => {
      row.read_btn.classList.add("user_interaction")
      if (!requestReading(row.story, "browser")) {
        open_story(row.story.href, "_self")
      } else {
        void getOnceClient().persistStoryChange(
          row.story.href,
          "read_state",
          "read"
        )
      }
    },
    onMiddleClick: () => {
      row.read_btn.classList.add("user_interaction")
      open_story(row.story.href, "middle")
    }
  })

  container.appendChild(link)

  const og_link = document.createElement("a")
  og_link.innerText = " [OG] "
  og_link.classList.add("og_href")
  og_link.dataset.testid = "story-external"
  og_link.href = row.story.href
  bindLinkBehavior(og_link, {
    onClick: () => {
      row.read_btn.classList.add("user_interaction")
      openStoryUrl(row.story.href, "_self", false)
    },
    onMiddleClick: () => {
      row.read_btn.classList.add("user_interaction")
      openStoryUrl(row.story.href, "middle", false)
    }
  })
  container.appendChild(og_link)
  if (link.href == og_link.href) {
    //og_link.style.opacity = "0.4"
    og_link.style.display = "none"
  }

  const hostname = document.createElement("a")
  hostname.classList.add("hostname")
  hostname.innerText = " (" + og_link.hostname + ") "
  hostname.href = "search:domain:" + og_link.hostname
  hostname.target = "search"
  bindLinkBehavior(hostname, {
    onClick: () => {
      StorySearch.searchStories("domain:" + og_link.hostname)
    }
  })
  container.appendChild(hostname)

  return link
}

/**
 * A filtered row shows the rule that hid it, as a read-only field that jumps
 * to the rule in settings rather than an editable input.
 */
export function buildFilterButton(row: StoryListItem): HTMLElement {
  const filter_btn = createIconButton("filter", "filter_btn", "imgs/filter.svg")
  if (!row.story.filter) return filter_btn

  filter_btn.title = "filtered"
  row.classList.add("filtered")
  const dinp = document.createElement("input")
  dinp.classList.add("filter_input")
  dinp.type = "text"
  dinp.value = row.story.filter
  dinp.style.cursor = "pointer"
  dinp.readOnly = true
  dinp.addEventListener("click", (event) => {
    event.stopPropagation()
    if (SettingsPanel.instance) {
      SettingsPanel.instance.highlight_filter(row.story.filter, true)
    }
  })
  filter_btn.prepend(dinp)
  filter_btn.style.borderColor = "red"
  return filter_btn
}

/** Dev-channel only; deletes the story from the local and synced database. */
export function buildPurgeButton(row: StoryListItem): HTMLElement {
  const purgeButton = createIconButton("purge story", "purge_btn")
  purgeButton.dataset.testid = "purge-story"
  purgeButton.textContent = "×"
  purgeButton.addEventListener("click", () => {
    void row.confirmPurge()
  })
  return purgeButton
}
