//import * as path from "path"
//import * as fs from "fs"
import { Story } from "../data/Story"
import { StoryListItem } from "./StoryListItem"

export declare interface PresenterOptions {
  story_button: {
    value: "always" | "handled" | "never"
    description: string
  }
  [key: string]: { value: boolean | string; description: string }
}

export declare interface Presenter {
  is_presenter_url: (url: string) => boolean
  present: (url: string) => void
  description: string
  presenter_options: PresenterOptions
  display_url: (url: string) => string
  story_elem_button?: (story: Story, intab: boolean) => HTMLElement
  context_link?: (/*con_menu: Menu, cmenu_data: CMenuData*/) => void
  handle(url: string): Promise<boolean>
  handle_url(url: string): Promise<boolean>
  init_in_webtab?(/*tab: WebTab*/): void
  [key: string]: ((...args: unknown[]) => unknown) | PresenterOptions | string
}

let presenters: Presenter[] = []

function get_active(): Presenter[] {
  if (presenters.length == 0) {
    //TODO: determine if active from settings
    const normalizedPath = "" //path.join(__dirname, "presenters")

    presenters = [] /* fs
      .readdirSync(normalizedPath)
      .map((file_name: string) => {
        //TODO: better check
        if (file_name.endsWith(".js")) {
          return require(path.join(normalizedPath, file_name))
        }
      })
      .filter(
        (presenter) =>
          presenter != undefined && presenter.present && presenter.description
      )*/
  }

  return presenters
}

export function modify_url(url: string): string {
  for (const presenter of get_active()) {
    if (presenter.is_presenter_url(url)) {
      return presenter.display_url(url)
    }
  }
  return url
}

export async function handled_by(url: string): Promise<boolean> {
  for (const presenter of get_active()) {
    const present_handles = await presenter.handle(url)
    if (present_handles) {
      return true
    }
  }
  return false
}

export function add_story_elem_buttons(
  story_el: StoryListItem,
  story: Story,
  intab = false
): void {
  get_active().forEach((presenter) => {
    if (Object.prototype.hasOwnProperty.call(presenter, "story_elem_button")) {
      if (
        presenter.presenter_options.story_button.value == "always" ||
        (presenter.presenter_options.story_button.value == "handled" &&
          presenter.handle_url(story.href))
      ) {
        const button = presenter["story_elem_button"](story, intab)
        story_el.button_group.appendChild(button)
      }
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

export function init_in_webtab(/*tab: WebTab*/): void {
  /*get_active().forEach((presenter) => {
    if (presenter.init_in_webtab) {
      presenter.init_in_webtab(tab)
    }
  })*/
}

export function context_link(/*con_menu: Menu, cmenu_data: CMenuData*/): void {
  get_active().forEach((presenter) => {
    if (Object.prototype.hasOwnProperty.call(presenter, "context_link")) {
      presenter["context_link"](/*con_menu, cmenu_data*/)
    }
  })
}
