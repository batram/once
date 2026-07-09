import {
  StoryParser
} from "@once/core"
import { createOnceApp, OnceClient } from "@once/app"
import {
  LoaderInsights,
  Menu,
  Search,
  SettingsPanel,
  StoryHistory,
  StoryList,
  StoryListItem,
  setOnceClient
} from "@once/ui-web"
import { createWebExtPlatform } from "@once/platform-webext"

document.addEventListener("DOMContentLoaded", async () => {
  const platform = createWebExtPlatform()
  const app = createOnceApp(platform)
  const client = app.client
  setOnceClient(client)

  await app.start()

  new SettingsPanel(client)
  new StoryHistory(client)
  StoryList.init(client)
  Menu.init(client)
  LoaderInsights.init(client)
  Search.init()
  StoryParser.addAllCssColors()

  const dev_cache = false

  client.subscribe("selectedUrlChanged", ({ url }) => {
    update_selected(client, url)
  })
  await client.reloadStories(dev_cache)

  document.querySelectorAll<HTMLElement>(".collapsebutton").forEach((x) => {
    x.onclick = collapse_menu
  })
})

function collapse_menu() {
  const menu = document.querySelector("#menu")
  if (menu.classList.contains("collapse")) {
    menu.classList.remove("collapse")
    document.querySelectorAll<HTMLElement>(".collapsebutton").forEach((x) => {
      x.innerText = "<"
    })
  } else {
    menu.classList.add("collapse")
    document.querySelectorAll<HTMLElement>(".collapsebutton").forEach((x) => {
      x.innerText = ">"
    })
  }
}

async function update_selected(client: OnceClient, href: string) {
  // ReaderMode: Extract and decode the original URL from the query string
  if (href.startsWith("about:reader?url=")) {
    const urlParams = new URLSearchParams(href.replace("about:reader", ""))
    href = decodeURIComponent(urlParams.get("url"))
  }

  const selected_container = document.querySelector("#selected_container")
  const selected_story_el =
    selected_container.querySelector<StoryListItem>("story-item")

  if (selected_story_el && selected_story_el.story.href == href) {
    return
  }

  const story = await client.findStoryByUrl(href)

  if (!story) {
    selected_container.innerHTML = ""
    return
  }

  const story_el = new StoryListItem(story)
  story_el.classList.add("selected")
  selected_container.innerHTML = ""
  selected_container.append(story_el)
}
