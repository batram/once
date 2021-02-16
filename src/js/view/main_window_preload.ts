import { OnceSettings } from "../OnceSettings"
import { SettingsPanel } from "../view/SettingsPanel"
import { TabWrangler } from "../view/TabWrangler"
import { URLRedirect } from "../data/URLRedirect"
import * as fullscreen from "./fullscreen"
import * as story_list from "./StoryList"
import * as search from "../data/search"
import * as side_menu from "./menu"
import * as seperation_slider from "./sep_slider"
import * as story_loader from "../data/StoryLoader"
import * as story_parser from "../data/parser"

document.addEventListener("DOMContentLoaded", async () => {
  new SettingsPanel()
  story_list.init()
  side_menu.init()
  fullscreen.render_listeners()
  search.init_search()
  seperation_slider.init_slider()
  story_parser.add_all_css_colors()
  const tab_content = document.querySelector<HTMLElement>("#tab_content")
  const tab_dropzone = document.querySelector<HTMLElement>("#tab_dropzone")
  if (tab_content && tab_dropzone) {
    const tab_wrangler = new TabWrangler(tab_dropzone, tab_content, {
      addtab_button: true,
    })
    tab_wrangler.grab_attached_or_new().then((has_attached) => {
      if (has_attached) {
        seperation_slider.collapse_left()
      }
    })
  }

  console.log("LDEV", process.env.LDEV == "1")

  const dev_cache = process.env.LDEV == "1"

  URLRedirect.dynamic_url_redirects = await OnceSettings.remote.get_redirectlist()
  const grouped_story_sources = await OnceSettings.remote.grouped_story_sources()
  if (grouped_story_sources) {
    story_loader.parallel_load_stories(grouped_story_sources, dev_cache)
  } else {
    console.error("no sources", grouped_story_sources)
  }
})
