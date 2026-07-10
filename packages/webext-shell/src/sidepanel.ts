import "webextension-polyfill"

import { createOnceApp, OnceClient } from "@once/app"
import {
  addCollectorColorStyles,
  LoaderInsights,
  Menu,
  Search,
  SettingsPanel,
  StoryHistory,
  StoryList,
  StoryListItem,
  setOnceClient,
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
  addCollectorColorStyles()

  client.subscribe("selectedUrlChanged", ({ url }) => {
    updateSelected(client, url)
  })
  await client.reloadStories(false)

  document.querySelectorAll<HTMLElement>(".collapsebutton").forEach((element) => {
    element.onclick = collapseMenu
  })
})

function collapseMenu() {
  const menu = document.querySelector("#menu")
  if (!menu) return

  const collapsed = menu.classList.toggle("collapse")
  document.querySelectorAll<HTMLElement>(".collapsebutton").forEach((element) => {
    element.innerText = collapsed ? ">" : "<"
  })
}

async function updateSelected(client: OnceClient, href: string) {
  if (!href) return

  if (href.startsWith("about:reader?url=")) {
    const urlParams = new URLSearchParams(href.replace("about:reader", ""))
    const readerUrl = urlParams.get("url")
    if (readerUrl) href = decodeURIComponent(readerUrl)
  }

  const selectedContainer = document.querySelector("#selected_container")
  if (!selectedContainer) return

  const selectedStory = selectedContainer.querySelector<StoryListItem>("story-item")
  if (selectedStory && selectedStory.story.href === href) return

  const story = await client.findStoryByUrl(href)
  selectedContainer.innerHTML = ""

  if (story) {
    const storyElement = new StoryListItem(story)
    storyElement.classList.add("selected")
    selectedContainer.append(storyElement)
  }
}
