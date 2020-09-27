import { OnceSettings } from "../OnceSettings"
import { TabWrangler } from "../view/TabWrangler"
import * as fullscreen from "./fullscreen"
import * as story_list from "./StoryList"
import * as search from "../data/search"
import { StoryMap } from "../data/StoryMap"
import * as side_menu from "./menu"
import * as seperation_slider from "./sep_slider"
import * as story_loader from "../data/StoryLoader"

document.addEventListener("DOMContentLoaded", async () => {
  new StoryMap()
  story_list.init()
  side_menu.init()
  fullscreen.render_listeners()
  const once_settings = new OnceSettings()
  search.init_search()
  seperation_slider.init_slider()

  const tab_content = document.querySelector<HTMLElement>("#tab_content")
  const tab_dropzone = document.querySelector<HTMLElement>("#tab_dropzone")
  if (tab_content && tab_dropzone) {
    const tab_wrangler = new TabWrangler(tab_dropzone, tab_content, {
      addtab_button: true,
    })
    if (tab_wrangler.grab_attached_or_new()) {
      seperation_slider.collapse_left()
    }
  }
  console.log("LDEV", process.env.LDEV == "1")

  const dev_cache = process.env.LDEV == "1"
  const story_sources = await once_settings.story_sources()

  story_loader.parallel_load_stories(story_sources, dev_cache)
})
