module.exports = {
  get_active,
  modify_url,
  add_story_elem_buttons,
  init_in_webtab,
}

import * as path from "path"
import * as fs from "fs"
import { Story } from "./data/Story"

function get_active() {
  //TODO: determine if active from settings
  var normalizedPath = path.join(__dirname, "presenters")

  return fs
    .readdirSync(normalizedPath)
    .map((file_name: string) => {
      //TODO: better check
      if (file_name.endsWith(".js")) {
        return require(path.join(normalizedPath, file_name))
      }
    })
    .filter((x) => {
      return x != undefined
    })
}

function modify_url(url: string) {
  for (let presenter of get_active()) {
    if (presenter.is_presenter_url(url)) {
      return presenter.display_url(url)
    }
  }
  return url
}

function add_story_elem_buttons(
  story_el: HTMLElement,
  story: Story,
  inmain: boolean = true
) {
  get_active().forEach((presenter) => {
    if (presenter.hasOwnProperty("story_elem_button")) {
      let button = presenter["story_elem_button"](story, inmain)
      story_el.appendChild(button)
    }
  })
}

//Do we need a sperate function for buttons and for init??
/*
function add_urlbar_buttons(elem, story, inmain = true) {
  get_active().forEach((presenter) => {
    if (presenter.hasOwnProperty("urlbar_button")) {
      let button = presenter["urlbar_button"](story, inmain)
      elem.appendChild(button)
    }
  })
}
*/

function init_in_webtab() {
  get_active().forEach((presenter) => {
    if (presenter.hasOwnProperty("init_in_webtab")) {
      presenter["init_in_webtab"]()
    }
  })
}
