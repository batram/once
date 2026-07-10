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
  const devCache = false

  client.subscribe("selectedUrlChanged", ({ url }) => {
    updateSelected(client, url)
  })
  await client.reloadStories(devCache)

  document.querySelectorAll<HTMLElement>(".collapsebutton").forEach((element) => {
    element.onclick = collapseMenu
  })
})

function collapseMenu() {
  const menu = document.querySelector("#menu")
  if (menu.classList.contains("collapse")) {
    menu.classList.remove("collapse")
    document.querySelectorAll<HTMLElement>(".collapsebutton").forEach((element) => {
      element.innerText = "<"
    })
  } else {
    menu.classList.add("collapse")
    document.querySelectorAll<HTMLElement>(".collapsebutton").forEach((element) => {
      element.innerText = ">"
    })
  }
}

async function updateSelected(client: OnceClient, href: string) {
  if (href.startsWith("about:reader?url=")) {
    const urlParams = new URLSearchParams(href.replace("about:reader", ""))
    href = decodeURIComponent(urlParams.get("url"))
  }

  const selectedContainer = document.querySelector("#selected_container")
  const selectedStory = selectedContainer.querySelector<StoryListItem>("story-item")

  if (selectedStory && selectedStory.story.href === href) {
    return
  }

  const story = await client.findStoryByUrl(href)

  if (!story) {
    selectedContainer.innerHTML = ""
    return
  }

  const storyElement = new StoryListItem(story)
  storyElement.classList.add("selected")
  selectedContainer.innerHTML = ""
  selectedContainer.append(storyElement)
}
