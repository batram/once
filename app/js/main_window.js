const settings = require("./js/settings")
const web_control = require("./js/web_control")
const seperation_slider = require("./js/view/sep_slider")
const search = require("./js/data/search")
const story_loader = require("./js/data/StoryLoader")
const fullscreen = require("./js/view/fullscreen")
fullscreen.init_listeners()

seperation_slider.init_slider()
web_control.webtab_comms()
/*

if (web_control.grab_attached_or_new()) {
  seperation_slider.collapse_left()
}

document.addEventListener("DOMContentLoaded", async (_e) => {
  settings.init()

  search.init_search()

  let dev_cache = process.env.LDEV == "1"
  let sources = await settings.story_sources()

  story_loader.parallel_load_stories(sources, dev_cache)
})
*/
