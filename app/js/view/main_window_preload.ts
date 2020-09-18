import * as settings from "../settings"
import * as web_control from "../web_control"
import * as fullscreen from "./fullscreen"
import * as story_list from "./StoryList"
import * as search from "../data/search"
import * as side_menu from "./menu"
import * as seperation_slider from "./sep_slider"
import * as story_loader from "../data/StoryLoader"

document.addEventListener("DOMContentLoaded", async (_e) => {
  story_list.init()
  side_menu.init()
  fullscreen.render_listeners()

  seperation_slider.init_slider()
  web_control.webtab_comms()

  if (web_control.grab_attached_or_new()) {
    seperation_slider.collapse_left()
  }

  settings.init()

  search.init_search()

  console.log("LDEV", process.env.LDEV == "1")

  let dev_cache = process.env.LDEV == "1"
  let sources = await settings.story_sources()

  story_loader.parallel_load_stories(sources, dev_cache)
})
