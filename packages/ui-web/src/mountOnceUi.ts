import { OnceClient } from "@once/app"
import { addCollectorColorStyles } from "./CollectorStyles"
import { LoaderInsights } from "./LoaderInsights"
import * as Menu from "./menu"
import * as Search from "./search"
import { setOnceClient } from "./client"
import { SettingsPanel } from "./SettingsPanel"
import { StoryHistory } from "./StoryHistory"
import * as StoryList from "./StoryList"
import { StoryListItem } from "./StoryListItem"

export interface MountOnceUiOptions {
  showHoveredLinks?: boolean
  onMenuCollapsedChanged?: (collapsed: boolean) => void
}

export async function mountOnceUi(
  client: OnceClient,
  options: MountOnceUiOptions = {}
): Promise<void> {
  setOnceClient(client)

  new SettingsPanel(client)
  new StoryHistory(client)
  StoryList.init(client)
  Menu.init(client)
  LoaderInsights.init(client, {
    showHoveredLinks: options.showHoveredLinks || false
  })
  Search.init()
  addCollectorColorStyles()

  client.subscribe("selectedUrlChanged", ({ url }) => {
    updateSelected(client, url)
  })
  client.subscribe("searchRequested", ({ query }) => {
    Search.searchStories(query)
  })

  await client.reloadStories(false)

  document.querySelectorAll<HTMLElement>(".collapsebutton").forEach((element) => {
    element.onclick = () => {
      const collapsed = toggleMenu()
      options.onMenuCollapsedChanged?.(collapsed)
    }
  })
}

function toggleMenu(): boolean {
  const menu = document.querySelector("#menu")
  if (!menu) return false

  const collapsed = menu.classList.toggle("collapse")
  document.querySelectorAll<HTMLElement>(".collapsebutton").forEach((element) => {
    element.innerText = collapsed ? ">" : "<"
  })
  return collapsed
}

async function updateSelected(client: OnceClient, href: string): Promise<void> {
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
