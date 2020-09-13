const filters = require("./js/filters")
const settings = require("./js/settings")
const story_parser = require("./js/parser")
const contextmenu = require("./js/contextmenu")
const web_control = require("./js/web_control")
const menu = require("./js/menu")
const stories = require("./js/view/StoryList")
const seperation_slider = require("./js/sep_slider")
const search = require("./js/search")
const story_loader = require("./js/data/StoryLoader")

document.addEventListener("DOMContentLoaded", async (_e) => {
  console.log("load?")

  settings.init()

  seperation_slider.init_slider()
  search.init_search()

  let dev_cache = process.env.LDEV == "1"
  let sources = await settings.story_sources()

  story_loader.parallel_load_stories(sources, dev_cache)
})
