const { remote, shell, clipboard, ipcRenderer } = require("electron")
const { Menu, MenuItem } = remote
const filters = require("./js/filters")
const settings = require("./js/settings")
const story_parser = require("./js/parser")
const contextmenu = require("./js/contextmenu")
const menu = require("./js/menu")
const stories = require("./js/stories")
const seperation_slider = require("./js/sep_slider")
const search = require("./js/search")

document.addEventListener("DOMContentLoaded", (_e) => {
  console.log("load?")

  settings.init()

  seperation_slider.init_slider()
  search.init_search()

  if (process.env.LDEV == "1") {
    settings.story_sources().then((x) => {
      stories.cache_load(x)
    })
  } else {
    settings.story_sources().then((x) => {
      stories.load(x)
    })
  }
})
