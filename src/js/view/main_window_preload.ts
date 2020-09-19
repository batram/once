import * as settings from "../settings"
import { TabWrangler } from "../view/TabWrangler"
import * as fullscreen from "./fullscreen"
import * as story_list from "./StoryList"
import * as search from "../data/search"
import { StoryMap } from "../data/StoryMap"
import * as side_menu from "./menu"
import * as seperation_slider from "./sep_slider"
import * as story_loader from "../data/StoryLoader"

document.addEventListener("DOMContentLoaded", async (_e) => {
  let story_map = new StoryMap()
  story_list.init()
  side_menu.init()
  fullscreen.render_listeners()
  settings.init()
  search.init_search()
  seperation_slider.init_slider()

  let tab_content = document.querySelector<HTMLElement>("#tab_content")
  let tab_dropzone = document.querySelector<HTMLElement>("#tab_dropzone")
  if (tab_content && tab_dropzone) {
    let tab_wrangler = new TabWrangler(tab_dropzone, tab_content, {
      addtab_button: true,
    })
    if (tab_wrangler.grab_attached_or_new()) {
      seperation_slider.collapse_left()
    }
  }
  console.log("LDEV", process.env.LDEV == "1")

  let dev_cache = process.env.LDEV == "1"
  let sources = await settings.story_sources()

  story_loader.parallel_load_stories(sources, dev_cache)
})
