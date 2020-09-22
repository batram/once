import * as path from "path"
import * as fs from "fs"
import { Story } from "../data/Story"

export { get_active, modify_url, add_story_elem_buttons, init_in_webtab }

export declare interface Presenter {
  is_presenter_url: (url: string) => boolean
  display_url: (url: string) => string
  story_elem_button?: (story: Story, intab: boolean) => HTMLElement
  [key: string]: (...args: unknown[]) => unknown
}

function get_active(): Presenter[] {
  //TODO: determine if active from settings
  const normalizedPath = path.join(__dirname, "presenters")

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

function modify_url(url: string): string {
  for (const presenter of get_active()) {
    if (presenter.is_presenter_url(url)) {
      return presenter.display_url(url)
    }
  }
  return url
}

function add_story_elem_buttons(
  story_el: HTMLElement,
  story: Story,
  intab = false
): void {
  get_active().forEach((presenter) => {
    if (Object.prototype.hasOwnProperty.call(presenter, "story_elem_button")) {
      const button = presenter["story_elem_button"](story, intab)
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

function init_in_webtab(): void {
  get_active().forEach((presenter) => {
    if (Object.prototype.hasOwnProperty.call(presenter, "init_in_webtab")) {
      presenter["init_in_webtab"]()
    }
  })
}
