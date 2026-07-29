import { Story } from "@once/core"
import { StoryListItem } from "../StoryListItem"
import * as outline from "./outline"

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
  handle(url: string): Promise<boolean>
  handle_url(url: string): boolean
  [key: string]: unknown
}

let presenters: Presenter[] = []

function get_active(): Presenter[] {
  if (presenters.length == 0) {
    //TODO: determine if active from settings

    //hardcode in available presenters, maybe dynamic am Sankt-Nimmerleins-Tag
    presenters = [outline as Presenter]
  }

  return presenters
}

export function add_story_elem_buttons(
  story_el: StoryListItem,
  story: Story,
  intab = false
): void {
  get_active().forEach((presenter) => {
    const story_elem_button = presenter.story_elem_button
    if (story_elem_button) {
      if (
        presenter.presenter_options.story_button.value == "always" ||
        (presenter.presenter_options.story_button.value == "handled" &&
          presenter.handle_url(story.href))
      ) {
        const button = story_elem_button(story, intab)
        story_el.button_group.appendChild(button)
      }
    }
  })
}
