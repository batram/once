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

seperation_slider.init_slider()
search.init_search()
stories.load(settings.story_sources())
