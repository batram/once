const settings = require("./settings")
const web_control = require("./web_control")
const seperation_slider = require("./view/sep_slider")
const side_menu = require("./view/menu")
const search = require("./data/search")
const story_loader = require("./data/StoryLoader")
const fullscreen = require("./view/fullscreen")

document.addEventListener("DOMContentLoaded", async (_e) => {
  side_menu.init()
  fullscreen.init_listeners()

  seperation_slider.init_slider()
  web_control.webtab_comms()

  if (web_control.grab_attached_or_new()) {
    seperation_slider.collapse_left()
  }

  settings.init()

  search.init_search()

  let dev_cache = true //process.env.LDEV == "1"
  let sources = await settings.story_sources()

  story_loader.parallel_load_stories(sources, dev_cache)
})
